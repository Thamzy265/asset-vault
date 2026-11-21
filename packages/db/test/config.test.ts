import { describe, expect, it } from "vitest";
import { ConfigError, loadDbConfig } from "../src/config.ts";

describe("loadDbConfig", () => {
  it("returns the database URL when it is a postgres URL", () => {
    const config = loadDbConfig({ DATABASE_URL: "postgres://vault:pw@postgres:5432/vault" });
    expect(config.databaseUrl).toBe("postgres://vault:pw@postgres:5432/vault");
  });

  it("fails fast with a message naming the missing variable", () => {
    expect(() => loadDbConfig({})).toThrow(ConfigError);
    expect(() => loadDbConfig({})).toThrow(/DATABASE_URL/);
  });

  it("rejects a value that is not a postgres URL", () => {
    expect(() => loadDbConfig({ DATABASE_URL: "mysql://x@y/z" })).toThrow(/DATABASE_URL/);
  });

  it("never echoes the value (it may contain a password)", () => {
    try {
      loadDbConfig({ DATABASE_URL: "not-a-url-secretpw" });
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("secretpw");
    }
  });
});

describe("loadDbConfig parses the whole URL at start (M1.1-T1)", () => {
  const SECRET = "parsepw987";

  it.each([
    ["non-numeric port", `postgres://vault:${SECRET}@host:notaport/vault`],
    ["port out of range", `postgres://vault:${SECRET}@host:70000/vault`],
    ["credentials but no host", `postgres://vault:${SECRET}@`],
    ["empty host before the port", `postgres://vault:${SECRET}@:5432/vault`],
    ["no host at all", "postgres:///vault"],
    ["no database name", `postgres://vault:${SECRET}@host:5432`],
    ["empty database name", `postgres://vault:${SECRET}@host:5432/`],
    ["space inside the host", `postgres://vault:${SECRET}@ho st:5432/vault`],
  ])("rejects %s with a ConfigError that names DATABASE_URL and hides the value", (_label, value) => {
    let caught: unknown;
    try {
      loadDbConfig({ DATABASE_URL: value });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as Error;
    expect(error.message).toMatch(/DATABASE_URL/);
    const everything = `${error.message}\n${error.stack}\n${JSON.stringify(error)}\n${String(error.cause ?? "")}`;
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(value);
  });

  it.each([
    ["no port", "postgres://vault:pw@postgres/vault"],
    ["IPv4 host and port", "postgres://vault:pw@127.0.0.1:5432/vault"],
    ["IPv6 host", "postgres://vault:pw@[::1]:5432/vault"],
    ["query parameters", "postgresql://vault:pw@db.internal:6543/vault?sslmode=require"],
    ["no credentials", "postgres://db/vault"],
  ])("accepts a complete URL (%s) and returns it unchanged", (_label, value) => {
    expect(loadDbConfig({ DATABASE_URL: value }).databaseUrl).toBe(value);
  });
});
