import { describe, expect, it } from "vitest";
import { ConfigError, loadDbConfig } from "../src/config.ts";

// Tester edge cases for M1.1: config comes only from env and is validated at start.
// "secretpw" stands in for a real password; no message may ever contain it.
const SECRET = "secretpw";

describe("loadDbConfig edge cases", () => {
  it.each([
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["no scheme", `vault:${SECRET}@host/db`],
    ["wrong scheme", `mysql://vault:${SECRET}@host/db`],
    ["scheme only", "postgres://"],
    ["upper-case scheme", `POSTGRES://vault:${SECRET}@host/db`],
    ["leading space", ` postgres://vault:${SECRET}@host/db`],
    ["http URL", `http://vault:${SECRET}@host/db`],
  ])("rejects %s with a ConfigError that names DATABASE_URL", (_label, value) => {
    expect(() => loadDbConfig({ DATABASE_URL: value })).toThrow(ConfigError);
    expect(() => loadDbConfig({ DATABASE_URL: value })).toThrow(/DATABASE_URL/);
  });

  it.each([
    ["not a URL", `not-a-url-${SECRET}`],
    ["wrong scheme with password", `mysql://vault:${SECRET}@host/db`],
    ["whitespace", `  ${SECRET}  `],
  ])("never echoes the value in the message or the error object (%s)", (_label, value) => {
    let caught: unknown;
    try {
      loadDbConfig({ DATABASE_URL: value });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as Error;
    const everything = `${error.message}\n${error.stack}\n${JSON.stringify(error)}\n${String(error.cause ?? "")}`;
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(value.trim());
  });

  it("ignores unrelated variables and does not return them", () => {
    const config = loadDbConfig({ DATABASE_URL: "postgres://u:p@h:5432/d", OTHER: "x", POSTGRES_PASSWORD: SECRET });
    expect(config).toEqual({ databaseUrl: "postgres://u:p@h:5432/d" });
  });

  it("accepts the postgresql:// scheme alias", () => {
    expect(loadDbConfig({ DATABASE_URL: "postgresql://u:p@h/d" }).databaseUrl).toBe("postgresql://u:p@h/d");
  });

  // Regression M1.1-T1: a URL that cannot be parsed used to pass "validation at
  // start" and only fail later (TypeError: Invalid URL from pg), keeping the app in
  // a 60 s retry loop instead of failing fast.
  it.each([
    ["non-numeric port", `postgres://vault:${SECRET}@host:notaport/db`],
    ["credentials but no host", `postgres://vault:${SECRET}@`],
  ])("rejects an unparseable URL at start (%s)", (_label, value) => {
    expect(() => loadDbConfig({ DATABASE_URL: value })).toThrow(ConfigError);
  });
});
