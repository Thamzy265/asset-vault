import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "./support/fresh-database.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function runCli(args: string[], env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
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
