import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

describe("worker main", () => {
  it("exits 1 with a clear message when DATABASE_URL is missing", async () => {
    const result = await run(process.execPath, [main], { env: { PATH: process.env.PATH ?? "" } }).then(
      () => ({ code: 0, stderr: "" }),
      (e: { code: number; stderr: string }) => e,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is required");
  });
});
