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
      env: { DATABASE_URL: "postgres://u:p@db:5432/x" },
      exit: r.exit,
      log: r.log,
      wait: async () => { throw new Error("Database unreachable after 60 s"); },
    });
    expect(r.exits).toEqual([1]);
    expect(r.logs.at(-1)).toMatchObject({ level: "error", msg: "database unreachable, exiting" });
  });

  it("does not exit when config is valid and the database answers", async () => {
    const r = recorder();
    await startupCheck({ env: { DATABASE_URL: "postgres://u:p@db:5432/x" }, exit: r.exit, log: r.log, wait: async () => {} });
    expect(r.exits).toEqual([]);
  });
});
