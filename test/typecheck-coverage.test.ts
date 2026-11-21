import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Regression M1.1-T4: no tsconfig covered the root test/ folder, so `pnpm typecheck`
// never type-checked these tests.
const run = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(repo, "node_modules/typescript/bin/tsc");

describe("pnpm typecheck covers the root test/ folder", () => {
  it("the typecheck script also runs tsc on the root tsconfig.json", () => {
    const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).toMatch(/(^|&&\s*)tsc -p tsconfig\.json(\s|$)/);
  });

  it("the root tsconfig.json includes every TypeScript file in test/", async () => {
    const { stdout } = await run(process.execPath, [tsc, "-p", "tsconfig.json", "--listFilesOnly"], { cwd: repo });
    const listed = new Set(stdout.trim().split("\n").map((f) => path.resolve(f.trim())));
    const files = readdirSync(path.join(repo, "test"), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join(repo, "test", f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(listed.has(file), path.relative(repo, file)).toBe(true);
  });
});
