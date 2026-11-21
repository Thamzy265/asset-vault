import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const dbCli = fileURLToPath(new URL("../../../packages/db/src/cli.ts", import.meta.url));
const SECRET = "secretpw";

async function exec(script: string, args: string[], env: Record<string, string>) {
  return run(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", ...env } }).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );
}

describe.each([
  ["worker main", main, []],
  ["db cli up", dbCli, ["up"]],
  ["db cli down", dbCli, ["down"]],
])("%s refuses bad DATABASE_URL at start (tester)", (_name, script, args) => {
  it.each([
    ["empty", ""],
    ["not a URL", `garbage-${SECRET}`],
    ["wrong scheme", `mysql://vault:${SECRET}@host/db`],
  ])("exits 1 immediately, names DATABASE_URL, never prints the value (%s)", async (_label, value) => {
    const started = Date.now();
    const result = await exec(script, args, { DATABASE_URL: value });
    expect(result.code).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000); // fail fast, no 60 s retry
    const output = result.stdout + result.stderr;
    expect(output).toContain("DATABASE_URL");
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(value === "" ? "\u0000" : value);
  });
});
