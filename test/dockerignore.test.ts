import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

// Reviewer finding L1: a nested .env (e.g. apps/web/.env) must never reach the
// Docker build context, or Next's standalone output copies it into the web image.
// Context-level check: the repo's real .dockerignore is applied by BuildKit to a
// planted tree, and a `FROM scratch` build exports exactly what the context held.
// No image is pulled or kept.
const run = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(path.join(tmpdir(), "vault-dockerignore-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const planted = [
  ".env",
  ".env.local",
  ".env.example",
  "apps/web/.env",
  "apps/web/.env.local",
  "apps/web/.env.production",
  "apps/web/.env.example",
  "apps/worker/.env",
  "packages/db/.env.development.local",
  "apps/web/src/page.ts",
];

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
  });
}

describe(".dockerignore keeps env files out of the build context (reviewer L1)", () => {
  it("sends no .env* file except .env.example, at any depth", async () => {
    const context = path.join(work, "context");
    const out = path.join(work, "out");
    for (const file of planted) {
      mkdirSync(path.dirname(path.join(context, file)), { recursive: true });
      writeFileSync(path.join(context, file), "PLANTED=1\n");
    }
    copyFileSync(path.join(repo, ".dockerignore"), path.join(context, ".dockerignore"));
    writeFileSync(path.join(work, "Dockerfile"), "FROM scratch\nCOPY . /\n");

    await run("docker", ["build", "--quiet", "-f", path.join(work, "Dockerfile"), "--output", `type=local,dest=${out}`, context], {
      timeout: 60_000,
    });

    const sent = listFiles(out).sort();
    expect(sent.filter((f) => /(^|\/)\.env/.test(f))).toEqual([".env.example", "apps/web/.env.example"]);
    expect(sent).toContain("apps/web/src/page.ts"); // the build itself worked
  });
});
