import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Found on the running stack (M1.3): Next bundles the proxy, pages and routes separately, each
// with its own @vault/db, and a production handle only resolves in the copy that opened it.
// So in production the web app must not share its handle through globalThis.
const DB = pathToFileURL(path.join(import.meta.dirname, "../src/server/db.ts")).href;

function probe(nodeEnv: string): boolean {
  const script = `
    const { getDb } = await import(${JSON.stringify(DB)});
    getDb();
    console.log(JSON.stringify("vaultDb" in globalThis));
    process.exit(0);`;
  const env = { ...process.env, NODE_ENV: nodeEnv, DATABASE_URL: "postgres://u@127.0.0.1:1/none" } as NodeJS.ProcessEnv;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env,
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").at(-1)!) as boolean;
}

describe("getDb() keeps its handle per bundle in production", () => {
  it("production: nothing on globalThis", () => expect(probe("production")).toBe(false));
  it("development: on globalThis (next dev reloads)", () => expect(probe("development")).toBe(true));
});
