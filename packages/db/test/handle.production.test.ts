import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Review N1: a symbol key on globalThis is never hidden (getOwnPropertySymbols and
// Reflect.ownKeys list it even when non-enumerable), and the map behind it gives the raw
// client. In production the map is module-private; only development keeps it on
// globalThis, for `next dev` reloads (L7, handle.test.ts). Run in a fresh Node process,
// so nothing an earlier test put on this process's globalThis counts.

const HANDLE = pathToFileURL(join(import.meta.dirname, "../src/handle.ts")).href;

/** Opens a handle in a fresh process and reports the symbols packages/db left on globalThis. */
function probe(nodeEnv: string | undefined): { added: string[]; resolves: boolean } {
  const script = `
    const before = new Set(Reflect.ownKeys(globalThis));
    const { openDatabase, kyselyOf, closeDatabase } = await import(${JSON.stringify(HANDLE)});
    const handle = openDatabase("postgres://u@127.0.0.1:1/none");
    const added = Reflect.ownKeys(globalThis).filter((k) => typeof k === "symbol" && !before.has(k)).map((k) => k.description ?? "");
    const resolves = typeof kyselyOf(handle).selectFrom === "function";
    await closeDatabase(handle);
    console.log(JSON.stringify({ added, resolves }));`;
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: nodeEnv };
  if (nodeEnv === undefined) delete env.NODE_ENV;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env,
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").at(-1)!) as { added: string[]; resolves: boolean };
}

describe("where the handle -> client map lives (review N1)", () => {
  it("production: no symbol from @vault/db on globalThis after opening a handle, and the handle still resolves", () => {
    const { added, resolves } = probe("production");
    expect(added.filter((d) => d.startsWith("@vault/db"))).toEqual([]);
    expect(added).not.toContain("@vault/db/clients");
    expect(resolves).toBe(true);
  });

  it("development: the map is on globalThis (for next dev reloads, L7), and the handle resolves", () => {
    const { added, resolves } = probe("development");
    expect(added).toContain("@vault/db/clients");
    expect(resolves).toBe(true);
  });

  // M1.3 carried item (f): fail safe. Only "development" and "test" share the map;
  // anything else, including unset or a typo, keeps it module-private.
  it.each([["unset", undefined], ["staging", "staging"], ["Production", "Production"], ["empty", ""]])(
    "NODE_ENV %s: no symbol from @vault/db on globalThis, and the handle still resolves",
    (_label, nodeEnv) => {
      const { added, resolves } = probe(nodeEnv);
      expect(added.filter((d) => d.startsWith("@vault/db"))).toEqual([]);
      expect(resolves).toBe(true);
    },
  );

  it("test: the map is on globalThis (vitest runs with NODE_ENV=test)", () => {
    expect(probe("test").added).toContain("@vault/db/clients");
  });
});
