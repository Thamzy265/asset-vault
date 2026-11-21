import { describe, expect, it } from "vitest";
import { startupCheck } from "../src/server/startup.ts";

function recorder() {
  const exits: number[] = [];
  const logs: Array<{ level: string; msg: string }> = [];
  return {
    exits,
    logs,
    exit: (code: number) => { exits.push(code); },
    log: (level: string, msg: string) => { logs.push({ level, msg }); },
  };
}

describe("web start-up check", () => {
  it("exits 1 at once with a clear message when DATABASE_URL is missing", async () => {
    const r = recorder();
    await startupCheck({ env: {}, exit: r.exit, log: r.log, wait: async () => {} });
    expect(r.exits).toEqual([1]);
    expect(r.logs.at(-1)).toMatchObject({ level: "error", msg: "invalid configuration" });
  });

  it("exits 1 when the database stays unreachable for the retry window", async () => {
    const r = recorder();
    await startupCheck({
      env: { DATABASE_URL: "postgres://u:p@db:5432/x", APP_URL: "http://127.0.0.1:3000", AUTH_ENCRYPTION_KEY: "k".repeat(40) },
      exit: r.exit,
      log: r.log,
      wait: async () => { throw new Error("Database unreachable after 60 s"); },
    });
    expect(r.exits).toEqual([1]);
    expect(r.logs.at(-1)).toMatchObject({ level: "error", msg: "database unreachable, exiting" });
  });

  it("does not exit when config is valid and the database answers", async () => {
    const r = recorder();
    await startupCheck({ env: { DATABASE_URL: "postgres://u:p@db:5432/x", APP_URL: "http://127.0.0.1:3000", AUTH_ENCRYPTION_KEY: "k".repeat(40) }, exit: r.exit, log: r.log, wait: async () => {} });
    expect(r.exits).toEqual([]);
  });

  // M1.3: the sign-in settings are checked at start too, so a missing key fails now, not at the first sign-in.
  it.each([
    ["AUTH_ENCRYPTION_KEY missing", { APP_URL: "http://127.0.0.1:3000" }],
    ["AUTH_ENCRYPTION_KEY too short", { APP_URL: "http://127.0.0.1:3000", AUTH_ENCRYPTION_KEY: "shortkey123" }],
    ["APP_URL missing", { AUTH_ENCRYPTION_KEY: "k".repeat(40) }],
    ["X-Forwarded-For as the trusted IP header", { APP_URL: "http://127.0.0.1:3000", AUTH_ENCRYPTION_KEY: "k".repeat(40), AUTH_TRUSTED_IP_HEADER: "x-forwarded-for" }],
  ])("exits 1 at once on bad sign-in settings: %s, without logging the key", async (_label, auth) => {
    const r = recorder();
    let waited = false;
    const lines: string[] = [];
    await startupCheck({
      env: { DATABASE_URL: "postgres://u:p@db:5432/x", ...auth },
      exit: r.exit,
      log: (level, msg, fields) => { r.log(level, msg); lines.push(JSON.stringify(fields)); },
      wait: async () => { waited = true; },
    });
    expect(r.exits).toEqual([1]);
    expect(waited).toBe(false);
    expect(r.logs.at(-1)).toMatchObject({ level: "error", msg: "invalid configuration" });
    expect(lines.join("")).not.toContain("shortkey123");
  });
});
