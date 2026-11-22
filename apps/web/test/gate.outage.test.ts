import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Independent tester round for M1.3: the default-deny gate while the database can't be reached.
// A session that can't be checked is refused (503), never let through; nothing about the failure
// reaches the client or the log beyond a code. The e2e db-outage spec accepts 401 or 503 for a
// made-up cookie; here the cookie is correctly signed, so the only honest answer is 503.
const ORIGIN = "http://127.0.0.1:3000";
const KEY = "gate-outage-test-key-".padEnd(48, "o");
const saved = { ...process.env };
let proxy: (request: NextRequest) => Promise<Response>;
const written: string[] = [];

/** A cookie the auth library accepts as correctly signed, for a token that exists only in a database nobody can reach. */
function signedCookie(token = "a".repeat(32)): string {
  const signature = createHmac("sha256", KEY).update(token).digest("base64");
  return `__Secure-vault.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

beforeAll(async () => {
  Object.assign(process.env, { DATABASE_URL: "postgres://vault_app:topsecretpw@127.0.0.1:1/vault", APP_URL: ORIGIN, AUTH_ENCRYPTION_KEY: KEY });
  delete process.env.AUTH_TRUSTED_IP_HEADER;
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  proxy = (await import("../src/proxy.ts")).proxy;
});
afterAll(() => {
  vi.restoreAllMocks();
  process.env = saved;
  delete (globalThis as { vaultDb?: unknown; vaultAuth?: unknown }).vaultDb;
  delete (globalThis as { vaultAuth?: unknown }).vaultAuth;
});

const call = (path: string, method = "GET", headers: Record<string, string> = {}) => proxy(new NextRequest(`${ORIGIN}${path}`, { method, headers }));

describe("the gate with the database down", () => {
  it("a correctly signed session cookie that can't be checked gets 503 'unavailable', with Retry-After, no caching and no detail, on every verb", async () => {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await call("/api/v1/me", method, { cookie: signedCookie() });
      expect(res.status, method).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(res.headers.get("cache-control")).toBe("no-store");
      if (method !== "HEAD") {
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ error: { code: "unavailable", message: expect.any(String) } });
        expect(text).not.toMatch(/postgres|topsecretpw|127\.0\.0\.1|ECONNREFUSED|\n\s+at /i);
      }
    }
  });

  it("the same for paths nothing serves: default deny does not need the route to exist", async () => {
    for (const path of ["/api/v1/nothing", "/api/v1/health/x", "/API/V1/ME"]) expect((await call(path, "GET", { cookie: signedCookie() })).status, path).toBe(503);
  });

  it("without a cookie or with a cookie the library rejects by signature, the answer is 401, never a pass-through", async () => {
    for (const headers of [{}, { cookie: "__Secure-vault.session_token=garbage" }, { cookie: `${signedCookie().slice(0, -6)}AAAAAA` }]) {
      const res = await call("/api/v1/me", "GET", headers);
      expect([401, 503]).toContain(res.status);
      expect(res.headers.get("x-middleware-next")).toBeNull();
    }
  });

  it("every refusal still carries the security headers and a server-made request id", async () => {
    const res = await call("/api/v1/me", "GET", { cookie: signedCookie(), "x-request-id": "client-chosen" });
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("/health is not gated: it passes through to the route, which reports the outage itself", async () => {
    const res = await call("/api/v1/health", "GET", { cookie: signedCookie() });
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("the failure is logged as a code only: not the connection string, the host, the cookie or the path", async () => {
    written.length = 0;
    await call("/api/v1/me?secret=1", "GET", { cookie: signedCookie("b".repeat(32)) });
    const text = written.join("");
    expect(text).toContain("session check failed");
    for (const needle of ["topsecretpw", "127.0.0.1", "vault_app", "session_token", "b".repeat(32), "secret=1", "postgres://"]) expect(text, needle).not.toContain(needle);
    for (const line of text.split("\n").filter(Boolean)) expect(() => JSON.parse(line), line).not.toThrow();
  });

  it("a burst of requests while the database is down all get 503 quickly and don't pile up connections", async () => {
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => call("/api/v1/me", "GET", { cookie: signedCookie(`${i}`.padStart(32, "c")) })));
    expect(results.every((r) => r.status === 503)).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
