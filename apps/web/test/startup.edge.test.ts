import { DatabaseUnavailableError } from "@vault/db";
import { describe, expect, it } from "vitest";
import { startupCheck } from "../src/server/startup.ts";

const SECRET = "secretpw";

describe("web start-up check never logs the connection string (tester)", () => {
  it("does not echo the value for an invalid DATABASE_URL", async () => {
    const lines: string[] = [];
    const exits: number[] = [];
    await startupCheck({
      env: { DATABASE_URL: `mysql://vault:${SECRET}@host/db` },
      exit: (c) => void exits.push(c),
      log: (level, msg, fields) => void lines.push(JSON.stringify({ level, msg, ...fields })),
      wait: async () => {},
    });
    expect(exits).toEqual([1]);
    expect(lines.join("\n")).toContain("DATABASE_URL");
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("does not leak the cause chain when the database stays unreachable", async () => {
    const lines: string[] = [];
    const exits: number[] = [];
    await startupCheck({
      env: { DATABASE_URL: `postgres://vault:${SECRET}@host/db` },
      exit: (c) => void exits.push(c),
      log: (level, msg, fields) => void lines.push(JSON.stringify({ level, msg, ...fields })),
      wait: async () => {
        throw new DatabaseUnavailableError("Database unreachable after 60 s", {
          cause: new Error(`connect ECONNREFUSED postgres://vault:${SECRET}@host/db`),
        });
      },
    });
    expect(exits).toEqual([1]);
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("exits once and only once on a bad config (does not go on to wait for the database)", async () => {
    let waited = false;
    const exits: number[] = [];
    await startupCheck({
      env: {},
      exit: (c) => void exits.push(c),
      log: () => {},
      wait: async () => {
        waited = true;
      },
    });
    expect(exits).toEqual([1]);
    expect(waited).toBe(false);
  });
});
