import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { BASE, Client, enrolledAccount, passwordOnlyAccount } from "./support/api-client.ts";
import { rawRequest, type RawResponse } from "./support/raw-http.ts";

// Independent tester round for M1.3, abuse case "I hit an API route someone forgot to protect",
// against the real production build (the default-deny gate in apps/web/src/proxy.ts was not built
// test-first). Every request is written byte for byte on a socket, so path tricks reach the server
// as sent. The question for every case: can it reach data without a full 2FA session?
test.describe.configure({ mode: "parallel" });

const run = promisify(execFile);
const project = process.env.COMPOSE_PROJECT_NAME ?? "asset-vault";

/** Paths aimed at /api/v1/me (the only route with user data) and at the public /health. */
const TRICKS = [
  "/api/v1/me",
  "/api/v1/me/",
  "/api/v1/me//",
  "//api/v1/me",
  "/api//v1/me",
  "/api/v1//me",
  "/./api/v1/me",
  "/api/./v1/me",
  "/api/v1/./me",
  "/api/v1/health/../me",
  "/api/v1/health/%2e%2e/me",
  "/api/v1/health/%2E%2E/me",
  "/api/v1/health/%2e%2e%2fme",
  "/api/v1/health/..%2Fme",
  "/api/v1/health/..;/me",
  "/api/v1/health/./../me",
  "/api/v1/health%2F..%2Fme",
  "/api/v1/health;x",
  "/api/v1/health;/../me",
  "/api/v1/health%00",
  "/api/v1/health%00/../me",
  "/api/v1/health%20",
  "/api/v1/health%09",
  "/api/v1/health.",
  "/api/v1/health..",
  "/api/v1/health/..",
  "/api/v1/health%2e",
  "/api/v1/Health",
  "/api/v1/HEALTH",
  "/API/V1/ME",
  "/Api/V1/Me",
  "/api/V1/me",
  "/api/v1/ME",
  "/api/v1%2Fme",
  "/api/v1%2fme",
  "/api%2Fv1%2Fme",
  "/api%2fv1/me",
  "/%61pi/v1/me",
  "/api/%76%31/me",
  "/api/v1/%6De",
  "/api/v1/m%65",
  "/api/v1/me%2F",
  "/api/v1/me%2e",
  "/api/v1/me.",
  "/api/v1/me.json",
  "/api/v1/me%00",
  "/api/v1/me%00.json",
  "/api/v1/me;jsessionid=1",
  "/api/v1/me?x=/api/v1/health",
  "/api/v1/me#/api/v1/health",
  "/api/v1/me?",
  "/api/v1/health/extra",
  "/api/v1/health/me",
  "/api/v1/health//me",
  "/api/v1/health/%252e%252e/me",
  "/api/v1/%2e%2e/v1/me",
  "/api/v1/..%2f..%2fv1/me",
  "/api/auth/../v1/me",
  "/api/auth/%2e%2e/v1/me",
  "/%2e%2e/api/v1/me",
  "/%2e%2e%2fapi/v1/me",
  "/_next/../api/v1/me",
  "/_next/static/../../api/v1/me",
  "/api/v1\\me",
  "/api\\v1\\me",
  "/api/v1/me\\",
  "/api/v1/é",
  "/api/v1/%C0%AE%C0%AE/me",
  "/api/v1/%ef%bc%8e%ef%bc%8e/me",
  "/api/v1/" + "a".repeat(5000),
  "/api/v1/" + "../".repeat(200) + "me",
  "/api/v1/" + "%2e%2e/".repeat(100) + "me",
];

/** Where a tricky path may harmlessly end: a refusal, a missing page, or a redirect to a path that is itself gated. */
const SAFE_STATUS = new Set([301, 302, 307, 308, 400, 401, 403, 404, 405, 414, 431]);

function expectNoData(path: string, res: RawResponse, who: string) {
  const label = `${who}: ${path.slice(0, 70)}`;
  expect(res.status, `${label} -> ${res.status}`).not.toBeGreaterThanOrEqual(500);
  expect(SAFE_STATUS.has(res.status), `${label} -> ${res.status}`).toBe(true);
  expect(res.body, label).not.toMatch(/"personId"|"role"|"schema"|"workerHeartbeat"|Welcome,/);
  if (res.location) {
    // A redirect stays on this site and never becomes a network-path reference (//host) or an absolute URL.
    expect(res.location, `${label} Location`).toMatch(/^\/(?![/\\])/);
  }
}

/** Follows at most 3 same-site redirects, as a browser would. */
async function follow(path: string, headers: Record<string, string> = {}, method = "GET"): Promise<RawResponse> {
  let res = await rawRequest(path, { headers, method });
  for (let i = 0; i < 3 && res.location && res.status >= 300 && res.status < 400; i++) res = await rawRequest(res.location, { headers, method });
  return res;
}

test("signed out: no path trick reaches /me, health data or any user data, and no redirect leaves the site", async () => {
  for (const path of TRICKS) {
    const res = await rawRequest(path);
    expectNoData(path, res, "signed out");
    const end = await follow(path);
    expect(end.status, `signed out, after redirects: ${path.slice(0, 70)}`).not.toBe(200);
  }
});

test("a password-only session (2FA not done) gets nothing from any path trick either, and the gate says 2fa_required where it answers", async () => {
  const half = await passwordOnlyAccount();
  const cookie = half.client.cookieHeader();
  for (const path of TRICKS) {
    const res = await rawRequest(path, { headers: { cookie } });
    expectNoData(path, res, "password only");
    const end = await follow(path, { cookie });
    expect(end.status, `password only, after redirects: ${path.slice(0, 70)}`).not.toBe(200);
    if (end.status === 403) expect(end.body).toContain("2fa_required");
  }
});

test("only /api/v1/health (and a trailing-slash redirect to it) is public: look-alikes that are not exactly it are refused", async () => {
  expect((await rawRequest("/api/v1/health")).status).toBe(200);
  expect((await rawRequest("/api/v1/health?x=1&y=/me")).status).toBe(200);
  expect((await rawRequest("/api/v1/health?/../me")).body).toContain('"db"'); // a query string is not a path
  const slash = await rawRequest("/api/v1/health/");
  expect([301, 308]).toContain(slash.status);
  expect(slash.location).toBe("/api/v1/health");
  // "/health/." is the same path as "/health/" once dot segments are resolved, so it is the same public page.
  const dot = await follow("/api/v1/health/.");
  expect(dot.status).toBe(200);
  for (const lookalike of ["/api/v1/health;x", "/api/v1/health.", "/api/v1/health%20", "/api/v1/Health", "/api/v1/health/extra", "/api/v1/health%00", "/api/v1/healthz", "/api/v1/health.json"]) {
    const res = await rawRequest(lookalike);
    expect(res.status, lookalike).toBe(401);
    expect(res.body).not.toContain('"db"');
  }
});

const SUPPORTED = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const UNSUPPORTED = ["TRACE", "PROPFIND", "PURGE", "LINK", "MKCOL", "SEARCH"];
const noCors = { origin: "https://evil.example", "access-control-request-method": "GET", "access-control-request-headers": "authorization" };

/** The web container's own output, to check what a request left behind (stack traces, unhandled rejections). */
async function webLog(): Promise<string> {
  const out = await run("docker", ["compose", "-p", project, "logs", "--no-color", "--no-log-prefix", "web"], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
  return `${out.stdout}\n${out.stderr}`;
}

test("every verb the app uses is refused signed out, on the real route and on a path nothing serves; OPTIONS never grants CORS", async () => {
  for (const path of ["/api/v1/me", "/api/v1/nothing-here", "/api/v1"]) {
    for (const method of SUPPORTED) {
      const res = await rawRequest(path, { method, headers: noCors });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.headers.get("access-control-allow-origin"), `${method} ${path}`).toBeUndefined();
      expect(res.headers.get("access-control-allow-credentials"), `${method} ${path}`).toBeUndefined();
    }
  }
});

test("a method the app doesn't use (TRACE and the like) is a JSON 405 with an Allow header on every path, before Next's runtime; no stack trace is logged", async () => {
  for (const method of UNSUPPORTED) {
    for (const path of ["/api/v1/me", "/api/v1/nothing-here", "/api/v1/health", "/api/auth/sign-in", "/sign-in", "/", "/_next/image?url=%2F&w=64&q=75", "/does-not-exist"]) {
      const res = await rawRequest(path, { method, headers: noCors });
      expect(res.status, `${method} ${path}`).toBe(405);
      expect(res.headers.get("allow")?.[0], `${method} ${path}`).toBe(SUPPORTED.join(", "));
      expect(JSON.parse(res.body), `${method} ${path}`).toEqual({ error: { code: "method_not_allowed", message: expect.any(String) } });
      expect(res.headers.get("access-control-allow-origin"), `${method} ${path}`).toBeUndefined();
    }
  }
  const log = await webLog();
  expect(log).not.toMatch(/method is unsupported|TypeError|\n\s+at (async )?\w[\w.<>]* \(/i);
});

test("nothing the client sends can stand in for a session: Authorization, API-key and identity headers, the Next middleware bypass headers, a stolen-looking cookie", async () => {
  const forged: Array<Record<string, string>> = [
    { authorization: "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9." },
    { authorization: "Basic YWRtaW46YWRtaW4=" },
    { "x-api-key": "admin" },
    { "x-user-id": "00000000-0000-4000-8000-000000000000", "x-user-role": "admin", "x-vault-user": "admin" },
    { "x-forwarded-user": "admin", "remote-user": "admin", "x-authenticated-user": "admin" },
    { "x-middleware-subrequest": "proxy" },
    { "x-middleware-subrequest": "middleware" },
    { "x-middleware-subrequest": "src/proxy" },
    { "x-middleware-subrequest": "proxy:proxy:proxy:proxy:proxy" },
    { "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware" },
    { "x-middleware-prefetch": "1" },
    { "x-nextjs-data": "1" },
    { "x-nextjs-rewrite": "/api/v1/health" },
    { "x-matched-path": "/api/v1/health" },
    { "x-invoke-path": "/api/v1/health", "x-invoke-status": "200" },
    { "x-original-url": "/api/v1/health", "x-rewrite-url": "/api/v1/health" },
    { "x-forwarded-host": "localhost", "x-forwarded-proto": "https", "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" },
    { "x-request-id": "00000000-0000-4000-8000-000000000000", "x-nonce": "abc" },
    { cookie: "__Secure-vault.session_token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%3D" },
    { cookie: "__Secure-vault.session_token=" + "A".repeat(4000) },
    { cookie: "vault.session_token=admin; session=admin; __Host-vault.session_token=admin" },
    { cookie: "__Secure-vault.session_data=" + Buffer.from(JSON.stringify({ session: { user: { id: "x", role: "admin", twoFactorEnabled: true } } })).toString("base64url") },
    { host: "localhost" },
    { host: "evil.example" },
  ];
  for (const headers of forged) {
    for (const path of ["/api/v1/me", "/api/v1/nope"]) {
      const res = await rawRequest(path, { headers });
      expect(res.status, `${path} with ${Object.keys(headers).join(",")}`).toBe(401);
      expect(res.body).toContain('"unauthorized"');
    }
    const page = await rawRequest("/", { headers });
    const label = `/ with ${Object.keys(headers).join(",")}`;
    if (headers["x-middleware-prefetch"] || headers["x-nextjs-data"]) {
      // Next answers these two with an empty JSON object and no page.
      expect(page.status === 200 ? page.body.trim() : "{}", label).toBe("{}");
    } else {
      expect([307, 308], label).toContain(page.status);
      expect(page.location).toMatch(/^\/sign-in/);
    }
  }
});

test("the identity is the session's alone: client-sent user ids, headers and query strings don't change who /me says you are", async () => {
  const a = await enrolledAccount("Alice Example", "admin");
  const b = await enrolledAccount("Bob Example", "member");
  const mine = await a.client.get("/api/v1/me", { "x-user-id": b.email, "x-forwarded-user": "bob", authorization: "Bearer bob" });
  expect(mine.status).toBe(200);
  expect(mine.body).toMatchObject({ name: "Alice Example", role: "admin" });
  for (const path of ["/api/v1/me?id=x&userId=x&role=member&as=bob", "/api/v1/me/", "/api/v1/health/../me", "//api/v1/me"]) {
    const res = await rawRequest(path, { headers: { cookie: a.client.cookieHeader() } });
    const end = res.location ? await rawRequest(res.location, { headers: { cookie: a.client.cookieHeader() } }) : res;
    expect(end.status, path).toBe(200);
    expect(JSON.parse(end.body), path).toMatchObject({ name: "Alice Example", role: "admin" });
  }
  const bobs = await b.client.get("/api/v1/me");
  expect(bobs.body).toMatchObject({ name: "Bob Example", role: "member" });
  expect(Object.keys(mine.body).sort()).toEqual(["id", "name", "personId", "role"]);
});

test("/me carries no CORS permission and is never cacheable, whoever asks", async () => {
  const a = await enrolledAccount();
  for (const client of [a.client, new Client()]) {
    const res = await client.get("/api/v1/me", { origin: "https://evil.example" });
    expect([200, 401]).toContain(res.status);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  }
});

test("page requests: signed out and password-only go to sign-in whatever the RSC and server-action headers say, and no user text is rendered", async () => {
  const half = await passwordOnlyAccount();
  for (const cookie of [undefined, half.client.cookieHeader()]) {
    const base: Record<string, string> = cookie ? { cookie } : {};
    const cases: Array<{ path: string; method?: string; headers?: Record<string, string>; body?: string }> = [
      { path: "/" },
      { path: "/?_rsc=abc", headers: { rsc: "1", "next-router-state-tree": "%5B%22%22%5D", "next-url": "/" } },
      { path: "/", headers: { rsc: "1", "next-router-prefetch": "1" } },
      { path: "/", method: "POST", headers: { "next-action": "00" + "ab".repeat(20), "content-type": "text/plain" }, body: "[]" },
      { path: "/", method: "POST", headers: { "next-action": "x", "content-type": "multipart/form-data; boundary=x" }, body: "--x--" },
      { path: "/index", headers: {} },
      { path: "/_next/data/anything/index.json" },
      { path: "/index.txt" },
      { path: "/__nextjs_original-stack-frame?file=/etc/passwd" },
      { path: "/_next/image?url=%2Fapi%2Fv1%2Fme&w=64&q=75" },
      { path: "/_next/image?url=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Fv1%2Fme&w=64&q=75" },
    ];
    for (const c of cases) {
      const res = await rawRequest(c.path, { method: c.method ?? "GET", headers: { ...base, ...c.headers }, ...(c.body !== undefined && { body: c.body }) });
      const label = `${cookie ? "password only" : "signed out"}: ${c.method ?? "GET"} ${c.path}`;
      expect(res.status, label).toBeLessThan(500);
      expect(res.body, label).not.toMatch(/Welcome,|"personId"|HomeShell/);
      expect([200].includes(res.status) && c.path === "/", label).toBe(false); // the home page is never served to them
    }
  }
});

test("the image optimizer is off: /_next/image is not served (404 or 405), never a 500, and leaves no unhandled rejection in the log", async () => {
  for (const path of ["/_next/image?url=%2F&w=64&q=75", "/_next/image?url=%2Fapi%2Fv1%2Fme&w=64&q=75", "/_next/image", "/_next/image?url=http%3A%2F%2F127.0.0.1%3A3000%2F&w=64&q=75"]) {
    for (const method of ["GET", "HEAD", "POST"]) {
      const res = await rawRequest(path, { method });
      expect([404, 405], `${method} ${path}`).toContain(res.status);
    }
  }
  const log = await webLog();
  expect(log).not.toMatch(/unhandledRejection|EACCES|ENOENT|image-optimizer|imageOptimizer/i);
});

test("a page that does not exist doesn't reflect the path, give a stack trace or set a cookie", async () => {
  const res = await rawRequest("/%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  expect(res.status).toBe(404);
  expect(res.body).not.toContain("<script>alert(1)");
  expect(res.body).not.toMatch(/at \w+ \(|node_modules|\.next\/server/);
  expect(res.headers.get("set-cookie")).toBeUndefined();
});

test("oversized request lines and headers are refused cleanly, never 2xx, and the server still answers afterwards", async () => {
  for (const path of ["/api/v1/me?" + "a=b&".repeat(20_000), "/" + "x".repeat(70_000), "/api/v1/" + "%2e".repeat(30_000)]) {
    const res = await rawRequest(path).catch(() => ({ status: 0 }) as RawResponse);
    expect([0, 400, 401, 404, 414, 431], path.slice(0, 40)).toContain(res.status);
  }
  const res = await rawRequest("/api/v1/me", { headers: { cookie: "a=" + "b".repeat(40_000) } }).catch(() => ({ status: 0 }) as RawResponse);
  expect([0, 400, 401, 431]).toContain(res.status);
  expect((await rawRequest("/api/v1/health")).status).toBe(200);
});

test("the browser bundle holds no secret: neither the encryption key nor the database password is in any script, and no source map is served", async () => {
  const env = await run("docker", ["compose", "-p", project, "exec", "-T", "web", "sh", "-c", 'printf "%s\\n%s" "$AUTH_ENCRYPTION_KEY" "$DATABASE_URL"'], { timeout: 60_000 });
  const [key, url] = env.stdout.split("\n");
  const password = /:\/\/[^:]+:([^@]+)@/.exec(url ?? "")?.[1];
  expect(key!.length).toBeGreaterThanOrEqual(32);
  expect(password?.length).toBeGreaterThan(8);
  const scripts = new Set<string>();
  for (const page of ["/sign-in", "/setup"]) {
    const html = (await rawRequest(page, { maxBody: 500_000 })).body;
    for (const m of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+\.js)"/g)) scripts.add(m[1]!);
  }
  expect(scripts.size).toBeGreaterThan(0);
  for (const script of scripts) {
    const res = await fetch(`${BASE}${script}`);
    const text = await res.text();
    expect(text.includes(key!), script).toBe(false);
    expect(text.includes(password!), script).toBe(false);
    expect(text, script).not.toMatch(/postgres:\/\//);
    expect([404, 400], `${script}.map`).toContain((await fetch(`${BASE}${script}.map`)).status);
  }
});
