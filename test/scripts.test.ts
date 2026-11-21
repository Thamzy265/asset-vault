import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Reviewer L8: a dependency audit command for every review and release, kept
// out of `pnpm check` so the check still works offline.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { scripts } = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> };

describe("package.json scripts", () => {
  it("deps:audit audits production dependencies at moderate severity and above", () => {
    expect(scripts["deps:audit"]).toBe("pnpm audit --prod --audit-level=moderate");
  });

  it("pnpm check does not run the audit (it needs the network)", () => {
    expect(scripts.check).not.toMatch(/audit/);
  });
});
