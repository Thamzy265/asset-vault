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
