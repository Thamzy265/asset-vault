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

describe("migration scripts use the one-shot migrate service (review L7)", () => {
  it("db:migrate runs the migrate service (its default command applies pending migrations)", () => {
    expect(scripts["db:migrate"]).toBe("docker compose run --rm --no-deps migrate");
  });

  it("db:rollback reverts the latest migration through the migrate service", () => {
    expect(scripts["db:rollback"]).toBe("docker compose run --rm --no-deps migrate node packages/db/src/cli.ts down");
  });
});

describe("user commands run in the worker image as vault_app (M1.3)", () => {
  it("user:create and user:deactivate call the users CLI through the worker service, without starting the stack", () => {
    expect(scripts["user:create"]).toBe("docker compose run --rm --no-deps worker node packages/db/src/users-cli.ts create");
    expect(scripts["user:deactivate"]).toBe("docker compose run --rm --no-deps worker node packages/db/src/users-cli.ts deactivate");
  });
});
