import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// M1.3 carried item (a): app code can't build a Viewer by hand. A plain object fails to
// type-check (apps/web/test/viewer.type.test.ts); a cast to Viewer is refused here by ESLint;
// and at run time the repositories refuse anything mintViewer didn't create
// (packages/db/test/viewer.test.ts).
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({ cwd: repo });

async function messages(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repo, filePath) });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-syntax" || m.ruleId === "no-restricted-imports").map((m) => m.message);
}

const FILES = ["apps/web/src/server/x.ts", "apps/web/src/app/api/v1/x/route.ts", "apps/worker/src/x.ts", "apps/web/test/x.test.ts"];

describe("no hand-made Viewer in apps/* (item a)", () => {
  it.each([
    ["as Viewer", 'import type { Viewer } from "@vault/db";\nconst v = { userId: "u", role: "admin", personId: null } as Viewer;'],
    ["as unknown as Viewer", 'import type { Viewer } from "@vault/db";\nconst v = ({} as unknown) as Viewer;'],
    ["<Viewer> assertion", 'import type { Viewer } from "@vault/db";\nconst v = <Viewer>{};'],
    ["as a renamed Viewer", 'import type { Viewer as V } from "@vault/db";\nconst v = {} as V;'],
    ["a deep import of mintViewer", 'import { mintViewer } from "@vault/db/src/viewer.ts";'],
  ])("ESLint rejects %s", async (_label, code) => {
    for (const file of FILES) expect(await messages(code, file), file).not.toEqual([]);
  });

  it("using a Viewer the session module gave you is fine", async () => {
    const code = 'import type { Viewer } from "@vault/db";\nexport function f(v: Viewer): string { return v.userId; }';
    expect(await messages(code, "apps/web/src/server/x.ts")).toEqual([]);
  });
});
