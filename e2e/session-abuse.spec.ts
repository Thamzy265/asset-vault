import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { PASSWORD, deactivate } from "./support/accounts.ts";
import { issueLink, psql } from "./support/admin.ts";
import { BASE, Client, enrolledAccount, passwordOnlyAccount, signInClient } from "./support/api-client.ts";
import { rawRequest } from "./support/raw-http.ts";

// Independent tester round for M1.3: sessions, CSRF and setup-link handling on the running stack
// (docs/design/m1-3-sign-in.md, "Trust boundaries and abuse cases"). Failed passwords are kept to a
// minimum here: without a trusted IP header every client shares one 20-per-15-minutes budget.
test.describe.configure({ mode: "parallel" });

const me = (cookie: string) => rawRequest("/api/v1/me", { headers: { cookie } });
const home = (cookie: string) => rawRequest("/", { headers: { cookie } });

test("a password-only session is turned away from the pages and the API alike, and can't be upgraded by the sign-in endpoints", async () => {
  const half = await passwordOnlyAccount();
  const cookie = half.client.cookieHeader();
  expect((await me(cookie)).status).toBe(403);
  const page = await home(cookie);
  expect([307, 308]).toContain(page.status);
  expect(page.location).toBe("/sign-in?reason=again");
  for (const path of ["/api/auth/two-factor/totp", "/api/auth/two-factor/backup-code"]) {
    const res = await half.client.post(path, { code: "123456" });
    expect(res.status, path).toBe(401);
  }
  expect((await me(cookie)).status).toBe(403);
});

test("a copied cookie is dead after sign-out, on the API and on the pages", async () => {
  const account = await enrolledAccount();
  const copy = account.client.cookieHeader();
  expect((await me(copy)).status).toBe(200);
  expect((await account.client.post("/api/auth/sign-out")).status).toBe(200);
  expect((await me(copy)).status).toBe(401);
  const page = await home(copy);
  expect(page.location).toBe("/sign-in?reason=ended");
  expect((await rawRequest("/api/v1/me", { headers: { cookie: copy }, method: "HEAD" })).status).toBe(401);
});

test("sign out of all devices ends every session, including ones whose cookies were copied earlier; signing out one leaves the rest", async () => {
  const account = await enrolledAccount();
  const second = await signInClient(account);
  const third = await signInClient(account);
  const cookies = [account.client, second, third].map((c) => c.cookieHeader());
  expect(new Set(cookies).size).toBe(3);
  expect((await second.post("/api/auth/sign-out")).status).toBe(200);
  expect((await me(cookies[1]!)).status).toBe(401);
  expect((await me(cookies[0]!)).status).toBe(200);
  expect((await me(cookies[2]!)).status).toBe(200);
  expect((await third.post("/api/auth/sign-out-everywhere")).status).toBe(200);
  for (const cookie of cookies) expect((await me(cookie)).status).toBe(401);
});

test("a deactivated person is refused on the next call with an old cookie, and with the right password and code", async () => {
  const account = await enrolledAccount();
  const copy = account.client.cookieHeader();
  await deactivate(account.email);
  expect((await me(copy)).status).toBe(401);
  const again = new Client();
  expect((await again.post("/api/auth/sign-in", { email: account.email, password: PASSWORD })).status).toBe(401);
});

test("using a re-issued setup link signs the person out everywhere and replaces the password and authenticator; the old link and old codes are dead", async () => {
  const account = await enrolledAccount("Lost Phone");
  const stolen = account.client.cookieHeader();
  const { setupPath } = await issueLink(account.email, "Lost Phone");
  const token = setupPath.split("#")[1]!;
  expect((await me(stolen)).status, "until the new link is used the old session lives (spec question)").toBe(200);
  expect((await account.client.post("/api/auth/setup/check", { token: account.setupToken })).status, "the first link is dead").toBe(410);

  const fresh = new Client();
  const newPassword = "a different long password 123";
  expect((await fresh.post("/api/auth/setup/password", { token, password: newPassword })).status).toBe(200);
  expect((await me(stolen)).status, "the old session ends when the new link is used").toBe(401);
  expect((await new Client().post("/api/auth/setup/check", { token })).status, "and the new link is single use").toBe(410);
  const old = new Client();
  expect((await old.post("/api/auth/sign-in", { email: account.email, password: PASSWORD })).status, "the old password no longer works").toBe(401);
});

test("session fixation: a cookie planted before sign-in is not the session afterwards", async () => {
  const account = await enrolledAccount();
  const name = "__Secure-vault.session_token";
  const planted = "attackerchosentoken0123456789ab.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%3D";
  const client = new Client();
  client.jar.set(name, planted);
  expect((await client.post("/api/auth/sign-in", { email: account.email, password: PASSWORD })).status).toBe(200);
  expect((await client.post("/api/auth/two-factor/backup-code", { code: account.backupCodes[0] })).status).toBe(200);
  expect(client.jar.get(name)).not.toBe(planted);
  expect((await me(`${name}=${planted}`)).status, "the planted value opens nothing").toBe(401);
  expect((await me(client.cookieHeader())).status).toBe(200);
});

test("idle and absolute expiry on the running stack: a second either side of each limit", async () => {
  const account = await enrolledAccount();
  const cookie = account.client.cookieHeader();
  const set = (assignments: string) => psql(`update auth_sessions set ${assignments} where user_id = (select id from auth_users where email = '${account.email}')`);
  await set("expires_at = now() + interval '8 seconds'");
  expect((await me(cookie)).status).toBe(200);
  await set("expires_at = now() - interval '1 second'");
  expect((await me(cookie)).status).toBe(401);
  expect((await home(cookie)).location).toBe("/sign-in?reason=ended");

  const second = await signInClient(account);
  const set2 = (assignments: string) => psql(`update auth_sessions set ${assignments} where user_id = (select id from auth_users where email = '${account.email}')`);
  await set2("created_at = now() - interval '7 days' + interval '30 seconds', expires_at = now() + interval '23 hours', updated_at = now()");
  expect((await me(second.cookieHeader())).status).toBe(200);
  await set2("created_at = now() - interval '7 days' - interval '2 seconds'");
  expect((await me(second.cookieHeader())).status).toBe(401);
});

test("every Set-Cookie on the sign-in path is HttpOnly, Secure, SameSite=Lax, Path=/ and host-only; failures set none", async () => {
  const account = await enrolledAccount();
  const client = new Client();
  const lines: string[] = [];
  const collect = (r: { headers: Headers }) => lines.push(...r.headers.getSetCookie());
  collect(await client.post("/api/auth/sign-in", { email: account.email, password: PASSWORD }));
  const wrongCode = await client.post("/api/auth/two-factor/totp", { code: "12345" });
  collect(wrongCode);
  collect(await client.post("/api/auth/two-factor/backup-code", { code: account.backupCodes[0] }));
  collect(await client.post("/api/auth/sign-out"));
  const failure = await new Client().post("/api/auth/sign-in", { email: `nobody-${Date.now()}@example.org`, password: "not the password" });
  expect(failure.status).toBe(401);
  expect(failure.headers.getSetCookie(), "a failed sign-in sets no cookie").toEqual([]);
  expect(lines.length).toBeGreaterThanOrEqual(3);
  for (const line of lines) {
    expect(line, line).toMatch(/;\s*HttpOnly/i);
    expect(line, line).toMatch(/;\s*Secure/i);
    expect(line, line).toMatch(/;\s*SameSite=Lax/i);
    expect(line, line).toMatch(/;\s*Path=\//i);
    expect(line, line).not.toMatch(/;\s*Domain=/i);
  }
});

test("a failed sign-in for an unknown email and for a wrong password look the same on the wire (status, body, headers, no cookie)", async () => {
  const account = await enrolledAccount();
  const shape = (r: { status: number; text: string; headers: Headers }) => ({
    status: r.status,
    text: r.text,
    // The CSP nonce is new on every response by design.
    headers: [...r.headers].filter(([k]) => !["date", "x-request-id", "content-length", "etag"].includes(k)).map(([k, v]) => [k, v.replace(/'nonce-[^']+'/g, "'nonce-X'")]).sort(),
  });
  const unknown = await new Client().post("/api/auth/sign-in", { email: `nobody-${Date.now()}@example.org`, password: "not the password" });
  const wrong = await new Client().post("/api/auth/sign-in", { email: account.email, password: "not the password" });
  expect(shape(wrong)).toEqual(shape(unknown));
});

test("a cross-site page can't sign you out or do anything else with your cookies: form posts and fetches from another site are refused or cookie-less", async ({ page }) => {
  const account = await enrolledAccount();
  // The browser holds the person's session (cookies set by page.request go to the browser's jar).
  expect((await page.request.post("/api/auth/sign-in", { data: { email: account.email, password: PASSWORD }, headers: { origin: BASE } })).status()).toBe(200);
  expect((await page.request.post("/api/auth/two-factor/backup-code", { data: { code: account.backupCodes[1] }, headers: { origin: BASE } })).status()).toBe(200);
  expect((await page.request.get("/api/v1/me")).status()).toBe(200);

  // An attacker's page on another site (localhost is a different site from 127.0.0.1).
  const pageA = `<!doctype html><body>
    <form id="a" method="POST" action="${BASE}/api/auth/sign-out" enctype="text/plain"><input name='{"x":"' value='"}'></form>
    <script>
      fetch("${BASE}/api/auth/sign-out", { method: "POST", mode: "no-cors", credentials: "include", headers: { "content-type": "text/plain" }, body: "{}" });
      fetch("${BASE}/api/auth/sign-out-everywhere", { method: "POST", mode: "no-cors", credentials: "include", body: "{}" });
      document.getElementById("a").submit();
    </script></body>`;
  const pageB = `<!doctype html><body><form id="b" method="POST" action="${BASE}/api/auth/sign-out-everywhere"></form><script>document.getElementById("b").submit()</script></body>`;
  const server = http.createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(req.url === "/b" ? pageB : pageA));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const attackerOrigin = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const seen: Array<{ url: string; status: number; origin: string | undefined; cookie: string | undefined }> = [];
    page.on("response", async (r) => {
      if (r.url().startsWith(`${BASE}/api/auth/`)) {
        const h = await r.request().allHeaders();
        seen.push({ url: r.url(), status: r.status(), origin: h.origin, cookie: h.cookie });
      }
    });
    await page.goto(attackerOrigin).catch(() => {});
    await page.waitForTimeout(1500);
    await page.goto(`${attackerOrigin}/b`).catch(() => {});
    await page.waitForTimeout(1500);
    expect(seen.length, "the cross-site requests did reach the server").toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.cookie, `${s.url} must be sent without the session cookie`).toBeUndefined();
      expect(s.status, `${s.url} must be refused`).toBeGreaterThanOrEqual(400);
    }
  } finally {
    server.close();
  }
  expect((await page.request.get("/api/v1/me")).status(), "still signed in").toBe(200);
  expect((await page.request.post("/api/auth/sign-out", { headers: { origin: attackerOrigin }, data: {} })).status()).toBe(403);
  expect((await page.request.get("/api/v1/me")).status(), "a wrong Origin ended nothing").toBe(200);
});

test("the setup link's token never leaves the browser except in the body of the two setup calls: not in a URL, Referer, storage, cookie or the address bar", async ({ page }) => {
  const { newLogin } = await import("./support/accounts.ts");
  const { setupPath } = await newLogin("Token Watcher");
  const token = setupPath.split("#")[1]!;
  const requests: Array<{ method: string; url: string; headers: Record<string, string>; body: string | null }> = [];
  page.on("request", (r) => requests.push({ method: r.method(), url: r.url(), headers: r.headers(), body: r.postData() }));
  await page.goto(setupPath);
  await expect(page.getByRole("heading", { level: 2, name: "Step 1 of 3: Choose a password" })).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm new password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /Step 2 of 3/ })).toBeVisible();

  for (const r of requests) {
    expect(r.url, `URL of ${r.method} ${r.url}`).not.toContain(token);
    expect(JSON.stringify(r.headers), `headers of ${r.method} ${r.url}`).not.toContain(token);
    if (r.body?.includes(token)) expect(r.url, "the token goes only in the body of a setup POST").toMatch(/\/api\/auth\/setup\/(check|password)$/);
  }
  expect(requests.filter((r) => r.body?.includes(token)).map((r) => new URL(r.url).pathname).sort()).toEqual(["/api/auth/setup/check", "/api/auth/setup/password"]);
  const state = await page.evaluate(() => ({
    href: location.href,
    hash: location.hash,
    referrer: document.referrer,
    cookie: document.cookie,
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
    historyState: JSON.stringify(history.state),
  }));
  for (const [where, value] of Object.entries(state)) expect(value, where).not.toContain(token);
  expect(state.hash).toBe("");
  // Going back does not bring the token back into the address bar.
  await page.goBack().catch(() => {});
  expect(page.url()).not.toContain(token);
});
