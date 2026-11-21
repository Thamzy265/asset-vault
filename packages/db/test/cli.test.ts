import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "./support/fresh-database.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function runCli(args: string[], env: Record<string, string>, timeout = 0) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
      timeout,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("db CLI (pnpm db:migrate / db:rollback)", () => {
  let url: string;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ url, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());

  it("`up` applies migrations and logs their names as JSON", async () => {
    const result = await runCli(["up"], { DATABASE_URL: url });
    expect(result.code).toBe(0);
    const line = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    expect(line).toMatchObject({ level: "info", msg: "migrations applied", migrations: ["0001_meta"] });
  });

  it("`down` reverts the latest migration", async () => {
    const result = await runCli(["down"], { DATABASE_URL: url });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"migrations":["0001_meta"]');
  });

  it("exits non-zero with a clear message when DATABASE_URL is missing", async () => {
    const result = await runCli(["up"], {});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is required");
  });

  it("exits non-zero on an unknown command", async () => {
    const result = await runCli(["sideways"], { DATABASE_URL: url });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage");
  });
});

describe("db CLI uses the migration connection limits (review L7)", () => {
  it("gives up after lock_timeout (10 s) with 55P03 when another session holds a table lock it needs, instead of waiting forever", async () => {
    const fresh = await freshDatabase();
    const holder = new pg.Client({ connectionString: fresh.url });
    await holder.connect();
    try {
      expect((await runCli(["up"], { DATABASE_URL: fresh.url })).code).toBe(0);
      // Every migrate run reads kysely_migration inside its transaction.
      await holder.query("begin");
      await holder.query("lock table kysely_migration in access exclusive mode");
      const started = Date.now();
      const result = await runCli(["up"], { DATABASE_URL: fresh.url }, 25_000);
      const seconds = (Date.now() - started) / 1000;
      expect(result.code).toBe(1);
      expect(seconds).toBeGreaterThan(9);
      expect(seconds).toBeLessThan(20);
      expect(result.stderr).toContain('"code":"55P03"'); // lock_not_available
    } finally {
      await holder.end();
      await fresh.drop();
    }
  }, 40_000);
});
