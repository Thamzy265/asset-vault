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

// Reviewer C2: the sign-in service holds the set of Viewers the session module minted. It must stay
// per module in every environment, or a Viewer minted by one bundle's @vault/db could be accepted by another's.
const AUTH = pathToFileURL(path.join(import.meta.dirname, "../src/server/auth.ts")).href;

function authProbe(nodeEnv: string): { onGlobal: boolean; sameInstance: boolean } {
  const script = `
    const { getAuth } = await import(${JSON.stringify(AUTH)});
    const a = getAuth();
    console.log(JSON.stringify({ onGlobal: Object.values(globalThis).includes(a) || "vaultAuth" in globalThis, sameInstance: getAuth() === a }));
    process.exit(0);`;
  const env = {
    ...process.env,
    NODE_ENV: nodeEnv,
    DATABASE_URL: "postgres://u@127.0.0.1:1/none",
    APP_URL: "http://127.0.0.1:3000",
    AUTH_ENCRYPTION_KEY: "singleton-test-key-".padEnd(40, "k"),
  } as NodeJS.ProcessEnv;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").at(-1)!) as { onGlobal: boolean; sameInstance: boolean };
}

describe("getAuth() keeps its service per module in every environment", () => {
  it.each(["production", "development", "test"])("%s: nothing on globalThis, one instance per module", (env) => {
    expect(authProbe(env)).toEqual({ onGlobal: false, sameInstance: true });
  });
});
