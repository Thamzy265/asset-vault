import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { waitForDatabaseReady } from "../src/database-ready.ts";
import { freshDatabase } from "./support/fresh-database.ts";

// Reviewer L3 + C3: the start-up wait in the worker, the web app and the
// migrate CLI logs why Postgres refused, as a code only, and gives up at once
// when retrying can't help. Each entry point runs as a real process.
const run = promisify(execFile);
const entry = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const worker = entry("../../../apps/worker/src/main.ts");
const cli = entry("../src/cli.ts");

async function exec(args: string[], env: Record<string, string>) {
  return run(process.execPath, args, { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 20_000 }).then(
    (r) => ({ code: 0, output: r.stdout + r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, output: e.stdout + e.stderr }),
  );
}

type Line = { level: string; msg: string; code?: string; attempt?: number };
const lines = (output: string) => output.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);

describe("start-up database wait logs the failure code and fails fast when retrying can't help", () => {
  let good: URL;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const fresh = await freshDatabase();
    good = new URL(fresh.url);
    drop = fresh.drop;
  });
  afterAll(async () => drop?.());

  describe.each([
    ["worker main", [worker]],
    ["db cli up", [cli, "up"]],
  ])("%s", (_name, args) => {
    it("wrong password: logs 28P01, exits 1 within seconds, never prints the password", async () => {
      const password = `wrong${randomBytes(6).toString("hex")}`;
      const url = new URL(good);
      url.password = password;
      const started = Date.now();
      const result = await exec(args, { DATABASE_URL: url.toString() });
      expect(result.code).toBe(1);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(result.output).not.toContain(password);
      expect(result.output).not.toContain("postgres://");
      const last = lines(result.output).at(-1);
      expect(last).toMatchObject({ level: "error", code: "28P01" });
      expect(lines(result.output).filter((l) => l.msg === "database not reachable, retrying")).toEqual([]);
    });

    it("unknown database: logs 3D000 and exits 1 within seconds", async () => {
      const url = new URL(good);
      url.pathname = "/no_such_database";
      const started = Date.now();
      const result = await exec(args, { DATABASE_URL: url.toString() });
      expect(result.code).toBe(1);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(lines(result.output).at(-1)).toMatchObject({ level: "error", code: "3D000" });
    });
  });

  it("a refused connection is retried, and each retry log carries the code only", async () => {
    const logged: Array<[string, string, Record<string, unknown>]> = [];
    const db = createDb(`postgres://vault:${"retrysecret1"}@127.0.0.1:1/vault`, { maxConnections: 1 });
    try {
      await expect(
        waitForDatabaseReady(db, { timeoutMs: 1_000, initialDelayMs: 100, log: (...l) => logged.push(l) }),
      ).rejects.toThrow(/unreachable/);
    } finally {
      await db.destroy();
    }
    expect(logged.length).toBeGreaterThan(1);
    for (const [level, msg, fields] of logged) {
      expect(level).toBe("warn");
      expect(msg).toBe("database not reachable, retrying");
      expect(Object.keys(fields).sort()).toEqual(["attempt", "code", "delayMs"]);
      expect(fields.code).toBe("ECONNREFUSED");
    }
    expect(JSON.stringify(logged)).not.toContain("retrysecret1");
  });
});
