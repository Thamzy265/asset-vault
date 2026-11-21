import { readdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { newLogin, PASSWORD } from "./support/accounts.ts";

// M1.3 on the running stack: security headers on every response (review L6), and the
// default-deny gate on every /api/v1 route (401 signed out, 403 2fa_required password-only).
const API_DIR = path.join(import.meta.dirname, "../apps/web/src/app/api/v1");

/** Every /api/v1 route file as a URL path (dynamic segments filled in). */
function apiPaths(): string[] {
  return readdirSync(API_DIR, { recursive: true, encoding: "utf8" })
    .filter((f) => /(^|\/)route\.tsx?$/.test(f))
    .map((f) => {
      const dir = path.dirname(f);
      const segments = dir === "." ? [] : dir.split(path.sep).map((s) => (s.startsWith("[[...") || s.startsWith("[...") ? "some/where" : s.startsWith("[") ? "00000000-0000-4000-8000-000000000000" : s));
      return ["/api/v1", ...segments].join("/");
    });
}

test("every response carries the security headers: pages, API, static assets, 404s", async ({ page, request }) => {
  await page.goto("/sign-in");
  const asset = await page.evaluate(() => (document.querySelector("script[src]") as HTMLScriptElement | null)?.src ?? "");
  expect(asset).toContain("/_next/static/");
  for (const target of ["/", "/sign-in", "/setup", "/api/v1/health", "/api/v1/me", "/api/auth/sign-in", "/no-such-page", new URL(asset).pathname]) {
    const res = await request.get(target);
    const headers = res.headers();
    expect(headers["content-security-policy"], target).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"], target).not.toContain("unsafe-inline");
    expect(headers["x-content-type-options"], target).toBe("nosniff");
    expect(headers["referrer-policy"], target).toBe("same-origin");
  }
});

test("the page runs under its CSP: no violation is reported while signing in", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("nobody@example.org");
  await page.getByLabel("Password", { exact: true }).fill("not the password!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Email or password is not right.")).toBeVisible();
  expect(violations).toEqual([]);
});

test("the sign-in page can't be framed (frame-ancestors 'none')", async ({ page, baseURL }) => {
  await page.setContent(`<iframe src="${new URL("/sign-in", baseURL).href}"></iframe>`);
  await page.waitForTimeout(1500);
  const framed = page.frames().find((f) => f.url().includes("/sign-in"));
  const text = framed ? await framed.evaluate(() => document.body?.innerText ?? "").catch(() => "") : "";
  expect(text).not.toContain("Sign in");
});

test("default deny: every /api/v1 route but /health is 401 signed out and 403 2fa_required with a password-only session", async ({ playwright, baseURL }) => {
  const paths = apiPaths();
  expect(paths).toEqual(expect.arrayContaining(["/api/v1/health", "/api/v1/me"]));
  const anon = await playwright.request.newContext({ baseURL: baseURL! });
  const half = await playwright.request.newContext({ baseURL: baseURL! });
  const { setupPath } = await newLogin();
  const token = setupPath.split("#")[1];
  const setup = await half.post("/api/auth/setup/password", { data: { token, password: PASSWORD }, headers: { origin: baseURL! } });
  expect(setup.status()).toBe(200);
  for (const p of paths.filter((x) => x !== "/api/v1/health")) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect((await anon.fetch(p, { method })).status(), `${method} ${p} signed out`).toBe(401);
      expect((await half.fetch(p, { method })).status(), `${method} ${p} password only`).toBe(403);
    }
  }
  expect((await anon.get("/api/v1/health")).status()).toBe(200);
  await anon.dispose();
  await half.dispose();
});

test("signed in with 2FA, an unknown /api/v1 path is a JSON 404 (the M1.1 shape)", async ({ page }) => {
  const { setupPath } = await newLogin();
  await page.goto(setupPath);
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm new password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  const key = (await page.locator("#setup-key").textContent())!.trim();
  const { totpCode } = await import("../packages/db/test/support/totp.ts");
  await page.getByLabel("6-digit code").fill(totpCode(key));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /Step 3 of 3/ })).toBeVisible();
  const res = await page.request.get("/api/v1/nope");
  expect(res.status()).toBe(404);
  expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
});

test("auth endpoints refuse a cross-site POST", async ({ request }) => {
  const res = await request.post("/api/auth/sign-in", { data: { email: "a@example.org", password: "x" }, headers: { origin: "https://evil.example" } });
  expect(res.status()).toBe(403);
});
