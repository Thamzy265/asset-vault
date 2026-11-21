import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { isProtectedApi, proxy } from "../src/proxy.ts";
import { contentSecurityPolicy } from "../src/server/security-headers.ts";

// M1.1 review L6, M1.3: security headers on every response, set by the proxy.
describe("security headers (proxy)", () => {
  it.each(["/", "/sign-in", "/setup", "/api/v1/health", "/_next/static/chunk.js", "/favicon.ico"])("%s gets CSP, nosniff, Referrer-Policy and a request id", async (p) => {
    const res = await proxy(new NextRequest(`http://127.0.0.1:3000${p}`, { headers: { "x-request-id": "client-chosen" } }));
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{24}' 'strict-dynamic'/);
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a fresh nonce every request, forwarded to the page render", async () => {
    const a = await proxy(new NextRequest("http://127.0.0.1:3000/"));
    const b = await proxy(new NextRequest("http://127.0.0.1:3000/"));
    expect(a.headers.get("content-security-policy")).not.toBe(b.headers.get("content-security-policy"));
    expect(a.headers.get("x-middleware-request-x-nonce")).toMatch(/^[A-Za-z0-9+/=]{24}$/);
  });

  it("no inline script, no eval in production, no plugins, no base-uri tricks", () => {
    const csp = contentSecurityPolicy("abc");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("the gate covers /api/v1 by prefix, case-insensitively, except exactly /api/v1/health", () => {
    for (const p of ["/api/v1", "/api/v1/me", "/API/v1/me", "/api/v1/health/x", "/api/v1/Health"]) expect(isProtectedApi(p), p).toBe(true);
    for (const p of ["/api/v1/health", "/api/auth/sign-in", "/", "/api/v10/x"]) expect(isProtectedApi(p), p).toBe(false);
  });
});
