import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { closeDatabase, createAuthService, openDatabase, type DbHandle } from "@vault/db";
import { NextRequest } from "next/server";
import { getDb as serverDb } from "../src/server/db.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestBrowser } from "../../../packages/db/test/support/auth-client.ts";
import { freshDatabase, type FreshDatabase } from "../../../packages/db/test/support/fresh-database.ts";
import { migrateUp } from "../../../packages/db/test/support/migrate.ts";
import { rawQuery } from "../../../packages/db/test/support/raw-sql.ts";

// M1.3 design note, abuse case "I hit an API route someone forgot to protect": every
// /api/v1/* route except /health requires a session with 2FA passed, enforced in one place
// (src/proxy.ts). This test lists every route file under app/api/v1 and every HTTP method
// it exports, and checks the proxy refuses each one: 401 without a session, 403 2fa_required
// with a password-only session.
const ORIGIN = "http://127.0.0.1:3000";
const KEY = "default-deny-test-key-".padEnd(48, "k");
const API_DIR = path.join(import.meta.dirname, "../src/app/api/v1");
const METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] as const;
const PUBLIC = new Set(["/api/v1/health"]);

/** Every route file as a URL path (dynamic segments filled in) and the methods it handles. */
function routes(): Array<{ file: string; path: string; methods: string[] }> {
  return readdirSync(API_DIR, { recursive: true, encoding: "utf8" })
    .filter((f) => /(^|\/)route\.tsx?$/.test(f))
    .map((f) => {
      const segments = path.dirname(f) === "." ? [] : path.dirname(f).split(path.sep);
      const urlPath = ["/api/v1", ...segments.map((s) => (s.startsWith("[[...") ? "some/where" : s.startsWith("[...") ? "some/where" : s.startsWith("[") ? "00000000-0000-4000-8000-000000000000" : s))].join("/");
      const source = readFileSync(path.join(API_DIR, f), "utf8");
      const methods = METHODS.filter((m) => new RegExp(`export\\s+(const|async function|function)\\s+${m}\\b`).test(source));
      // HEAD is derived from GET by Next.
      if (methods.includes("GET") && !methods.includes("HEAD")) methods.push("HEAD");
      return { file: f, path: urlPath.replace(/\/$/, ""), methods };
    });
}

let fresh: FreshDatabase;
let db: DbHandle;
let proxy: (request: NextRequest) => Promise<Response>;
let passwordOnlyCookie: string;
const saved = { ...process.env };

beforeAll(async () => {
  fresh = await freshDatabase();
  const migrating = openDatabase(fresh.url);
  await migrateUp(migrating);
  await closeDatabase(migrating);
  Object.assign(process.env, { DATABASE_URL: fresh.appUrl, APP_URL: ORIGIN, AUTH_ENCRYPTION_KEY: KEY });
  delete process.env.AUTH_TRUSTED_IP_HEADER;
  proxy = (await import("../src/proxy.ts")).proxy;

  // A user who set a password but has not enrolled 2FA yet.
  db = openDatabase(fresh.appUrl);
  const auth = createAuthService(db, { appUrl: ORIGIN, encryptionKey: KEY, trustedIpHeader: null });
  const { createLogin } = await import("../../../packages/db/test/support/logins.ts");
  const created = await createLogin(db, { email: "half@example.org", name: "Half", role: "member" });
  const b = new TestBrowser((r) => auth.handle(r), ORIGIN);
  expect((await b.post("/api/auth/setup/password", { token: created.setupToken, password: "correct horse battery" })).status).toBe(200);
  passwordOnlyCookie = b.cookieHeader();
});
afterAll(async () => {
  process.env = saved;
  await closeDatabase(db);
  await closeDatabase(serverDb()).catch(() => {});
  delete (globalThis as { vaultDb?: unknown }).vaultDb;
  await fresh.drop();
});

const call = (urlPath: string, method: string, cookie?: string) =>
  proxy(new NextRequest(`${ORIGIN}${urlPath}`, { method, headers: cookie ? { cookie } : {} }));

describe("default-deny on /api/v1 (M1.3)", () => {
  it("finds the route files, including /me and the catch-all", () => {
    const paths = routes().map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(["/api/v1/health", "/api/v1/me", "/api/v1/some/where"]));
  });

  it("every route and method except /health is 401 without a session, in the API's error shape", async () => {
    for (const route of routes().filter((r) => !PUBLIC.has(r.path))) {
      for (const method of route.methods) {
        const res = await call(route.path, method);
        expect(res.status, `${method} ${route.path}`).toBe(401);
        if (method !== "HEAD") expect(await res.json(), `${method} ${route.path}`).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
      }
    }
  });

  it("every route and method except /health is 403 2fa_required with a password-only session", async () => {
    for (const route of routes().filter((r) => !PUBLIC.has(r.path))) {
      for (const method of route.methods) {
        const res = await call(route.path, method, passwordOnlyCookie);
        expect(res.status, `${method} ${route.path}`).toBe(403);
        if (method !== "HEAD") expect(await res.json(), `${method} ${route.path}`).toEqual({ error: { code: "2fa_required", message: expect.any(String) } });
      }
    }
  });

  it("paths no route matches are refused too (default deny, not 404): the gate is by prefix, not by a list", async () => {
    for (const p of ["/api/v1", "/api/v1/", "/api/v1/nope", "/api/v1/Health", "/api/v1/health/extra", "/API/V1/me", "/api/v1/%68ealth", "/api/v1//me"]) {
      expect((await call(p, "GET")).status, p).toBe(401);
    }
  });

  it("/health passes through without a session (the proxy lets the route answer)", async () => {
    const res = await call("/api/v1/health", "GET");
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("a session cookie of a deactivated user is refused (item b)", async () => {
    await rawQuery(fresh.url, "update users set deactivated_at = now() where deactivated_at is null");
    expect((await call("/api/v1/me", "GET", passwordOnlyCookie)).status).toBe(401);
  });
});
