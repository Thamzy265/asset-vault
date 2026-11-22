import { describe, expect, it } from "vitest";
import { loadAuthConfig } from "../src/auth/config.ts";
import { ConfigError } from "../src/config.ts";

const KEY = "k".repeat(31) + "Z";
const ok = { APP_URL: "https://vault.example.org", AUTH_ENCRYPTION_KEY: KEY };

describe("loadAuthConfig (M1.3)", () => {
  it("returns the app origin, the key, and no trusted IP header by default", () => {
    expect(loadAuthConfig(ok)).toEqual({ appUrl: "https://vault.example.org", encryptionKey: KEY, trustedIpHeader: null });
  });

  it("accepts a trailing slash on the origin and an http origin with a port (local use)", () => {
    expect(loadAuthConfig({ ...ok, APP_URL: "https://vault.example.org/" }).appUrl).toBe("https://vault.example.org");
    expect(loadAuthConfig({ ...ok, APP_URL: "http://127.0.0.1:3000" }).appUrl).toBe("http://127.0.0.1:3000");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a URL", "vault"],
    ["another scheme", "ftp://vault.example.org"],
    ["a path", "https://vault.example.org/app"],
    ["a query", "https://vault.example.org?x=1"],
    ["credentials", "https://u:p@vault.example.org"],
  ])("refuses an APP_URL with %s", (_label, value) => {
    expect(() => loadAuthConfig({ ...ok, APP_URL: value })).toThrow(ConfigError);
    expect(() => loadAuthConfig({ ...ok, APP_URL: value })).toThrow(/APP_URL/);
  });

  it.each([
    ["missing", undefined],
    ["empty (Compose refuses this too)", ""],
    ["shorter than 32 characters", "k".repeat(31)],
    ["with a space", `${"k".repeat(32)} x`],
  ])("refuses an AUTH_ENCRYPTION_KEY that is %s, without echoing it", (_label, value) => {
    try {
      loadAuthConfig({ ...ok, AUTH_ENCRYPTION_KEY: value });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toMatch(/AUTH_ENCRYPTION_KEY/);
      if (value) expect((error as Error).message).not.toContain(value);
    }
  });

  it("takes a trusted IP header name, lower-cased; blank means none", () => {
    expect(loadAuthConfig({ ...ok, AUTH_TRUSTED_IP_HEADER: "CF-Connecting-IP" }).trustedIpHeader).toBe("cf-connecting-ip");
    expect(loadAuthConfig({ ...ok, AUTH_TRUSTED_IP_HEADER: "  " }).trustedIpHeader).toBeNull();
  });

  it.each(["x-forwarded-for", "X-Forwarded-For", "forwarded", "x-real-ip"])("never trusts %s for the client IP", (header) => {
    expect(() => loadAuthConfig({ ...ok, AUTH_TRUSTED_IP_HEADER: header })).toThrow(/AUTH_TRUSTED_IP_HEADER/);
  });

  it("refuses a value that is not a header name", () => {
    expect(() => loadAuthConfig({ ...ok, AUTH_TRUSTED_IP_HEADER: "cf connecting ip" })).toThrow(/AUTH_TRUSTED_IP_HEADER/);
  });
});
