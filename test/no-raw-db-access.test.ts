import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import * as publicApi from "../packages/db/src/index.ts";

// M1.2 design note, top quality "Authorisation": no query path bypasses the
// visibility check. Apps reach the database only through @vault/db's
// functions and repositories, never through a raw Kysely client or pg pool.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({ cwd: repo });

async function restricted(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repo, filePath) });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax").map((m) => m.message);
}

describe("no raw database access outside packages/db", () => {
  it.each([
    ['import { Kysely, sql } from "kysely";', "kysely"],
    ['import { Migrator } from "kysely/migration";', "kysely subpath"],
    ['import pg from "pg";', "pg"],
    ['import Pool from "pg-pool";', "pg-pool"],
    ['import { createDb } from "../../../../packages/db/src/client.ts";', "relative path into packages/db/src"],
    ['import { createDb } from "@vault/db/src/client.ts";', "deep import into @vault/db"],
    ['export { createDb } from "../../../packages/db/src/client.ts";', "re-export"],
    ['const k = await import("kysely");', "dynamic import"],
  ])("ESLint rejects %s in apps/* (%s)", async (code, _label) => {
    for (const file of ["apps/web/src/server/x.ts", "apps/worker/src/x.ts", "apps/web/src/app/api/v1/x/route.ts"]) {
      expect(await restricted(code, file), file).not.toEqual([]);
    }
  });

  it("allows the public @vault/db API in apps/*", async () => {
    expect(await restricted('import { openDatabase, peopleRepository } from "@vault/db";', "apps/web/src/server/x.ts")).toEqual([]);
  });

  it("allows raw access inside packages/db itself", async () => {
    expect(await restricted('import { Kysely, sql } from "kysely";\nimport pg from "pg";', "packages/db/src/x.ts")).toEqual([]);
  });

  it("the public API exports no raw client factory or query builder", () => {
    for (const name of ["createDb", "createMigrationDb", "kyselyOf", "sql", "Kysely"]) {
      expect(Object.keys(publicApi), name).not.toContain(name);
    }
  });

  it("migrations are not part of the app API: migrateUp/migrateDown live in an entry point only the migrate CLI imports (decision 9)", async () => {
    for (const name of ["migrateUp", "migrateDown", "migrations"]) expect(Object.keys(publicApi), name).not.toContain(name);
    const src = path.join(repo, "packages/db/src");
    const importers = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && /from\s+["'][./]+(?:[\w-]+\/)*migrate\.ts["']/.test(readFileSync(path.join(src, f), "utf8")))
      .sort();
    expect(importers).toEqual(["cli.ts"]);
    for (const code of ['import { migrateUp } from "@vault/db/migrate";', 'import { migrateUp } from "../../../../packages/db/src/migrate.ts";']) {
      expect(await restricted(code, "apps/web/src/server/x.ts"), code).not.toEqual([]);
    }
  });

  it("a database handle exposes no query methods and no client", () => {
    const handle = publicApi.openDatabase("postgres://u@127.0.0.1:1/none");
    try {
      for (const method of ["selectFrom", "insertInto", "updateTable", "deleteFrom", "executeQuery", "transaction", "connection"]) {
        expect(method in handle, method).toBe(false);
      }
      expect(Object.values(handle).some((v) => typeof v === "object" && v !== null)).toBe(false);
    } finally {
      void publicApi.closeDatabase(handle);
    }
  });
});

// Tester round L1-L7 (M1.2). The DB roles are the real backstop (decision 3); this rule is the guardrail.
describe("raw database access bypasses stay closed in apps/**", () => {
  const SRC = "apps/web/src/server/x.ts";
  const TEST = "apps/web/test/x.test.ts";

  it("dynamic import specifiers must be plain string literals (L1, L2)", async () => {
    for (const code of [
      "const m = 'kysely'; await import(m);",
      "await import(`kysely`);",
      "await import(`${'ky'}sely`);",
      'await import("ky" + "sely");',
      'await import(["kysely"].join(""));',
      "await import(String.raw`kysely`);",
    ]) {
      expect(await restricted(code, SRC), code).not.toEqual([]);
    }
  });

  it("require, createRequire, module.require, process.getBuiltinModule and node:module are rejected (L3)", async () => {
    for (const code of [
      'const k = require("kysely");',
      'import { createRequire } from "node:module";',
      'import { createRequire } from "module";',
      'import * as m from "node:module";',
      'const m = await import("node:module");',
      "const r = module.require;",
      'const r = process.getBuiltinModule("module").createRequire(import.meta.url);',
      'const { createRequire: cr } = process.getBuiltinModule("node:module");',
      'const r = globalThis["require"];',
      'import k = require("kysely");',
    ]) {
      expect(await restricted(code, code.includes("import k =") ? SRC : "apps/worker/src/x.ts"), code).not.toEqual([]);
    }
  });

  it("file:, data: and package #subpath specifiers are rejected (they can name any file or module)", async () => {
    for (const code of [
      'import x from "file:///repo/packages/db/src/handle.ts";',
      'import x from "file:///repo/pack%61ges/db/src/handle.ts";',
      'await import("data:text/javascript,export default 1");',
      'import k from "#db";',
    ]) {
      expect(await restricted(code, SRC), code).not.toEqual([]);
    }
  });

  it("app production code can't reach any path under packages/ or node_modules, however it is spelled (L4, L6)", async () => {
    for (const spec of [
      "../../../../packages/db/./src/handle.ts",
      "../../../../packages/db//src/handle.ts",
      "../../../../packages/db/../db/src/handle.ts",
      "../../../../packages/./db/src/handle.ts",
      "../../../../Packages/DB/src/handle.ts",
      "../../../../apps/../packages/db/src/handle.ts",
      "../../../../packages/db/test/support/raw-sql.ts",
      "../../../../packages/db/test/support/fresh-database.ts",
      "../../../../packages/db",
      "../../node_modules/@vault/db/src/handle.ts",
      "../../../../node_modules/.pnpm/kysely@0.29.9/node_modules/kysely/dist/esm/index.js",
      "/abs/repo/packages/db/src/handle.ts",
    ]) {
      expect(await restricted(`import x from "${spec}";`, SRC), spec).not.toEqual([]);
      expect(await restricted(`export * from "${spec}";`, SRC), spec).not.toEqual([]);
      expect(await restricted(`await import("${spec}");`, SRC), spec).not.toEqual([]);
    }
  });

  it("app tests may use packages/db/test/support/*, but never packages/db/src or a path that leaves support (L4, L6)", async () => {
    for (const spec of ["../../../packages/db/test/support/fresh-database.ts", "../../../packages/db/test/support/migrate.ts", "../../../packages/db/test/support/raw-sql.ts"]) {
      expect(await restricted(`import x from "${spec}";`, TEST), spec).toEqual([]);
    }
    for (const spec of [
      "../../../packages/db/src/handle.ts",
      "../../../packages/db/./src/handle.ts",
      "../../../packages/db/test/support/../../src/handle.ts",
      "../../../packages/db/test/support/../support/../../src/handle.ts",
      "../../../packages/db/test/people.test.ts",
      "../../node_modules/kysely",
    ]) {
      expect(await restricted(`import x from "${spec}";`, TEST), spec).not.toEqual([]);
    }
  });

  it("ordinary app imports are untouched", async () => {
    for (const code of [
      'import { openDatabase } from "@vault/db";',
      'import pkg from "../../package.json" with { type: "json" };',
      'import { getHealth } from "./health.ts";',
      'import { NextResponse } from "next/server";',
      'import { readFileSync } from "node:fs";',
      'const page = await import("./page.tsx");',
    ]) {
      expect(await restricted(code, SRC), code).toEqual([]);
    }
  });

  // Review L3: pg-boss's getDb().executeSql(...) runs any SQL as vault_app with no visibility check.
  it("pg-boss may be imported only by apps/worker/src/worker.ts", async () => {
    const WORKER = "apps/worker/src/worker.ts";
    expect(await restricted('import { PgBoss } from "pg-boss";', WORKER)).toEqual([]);
    for (const file of ["apps/worker/src/x.ts", "apps/worker/src/main.ts", "apps/web/src/server/x.ts", "apps/worker/test/x.test.ts", "apps/worker/src/worker.mts"]) {
      for (const code of [
        'import { PgBoss } from "pg-boss";',
        'import PgBoss from "pg-boss";',
        'export { PgBoss } from "pg-boss";',
        'const m = await import("pg-boss");',
        'import x from "pg-boss/dist/index.js";',
      ]) {
        expect(await restricted(code, file), `${file}: ${code}`).not.toEqual([]);
      }
    }
  });

  it("getDb and executeSql member access is rejected everywhere in apps/**, worker.ts included", async () => {
    for (const file of ["apps/worker/src/worker.ts", "apps/worker/src/x.ts", "apps/web/src/server/x.ts", "apps/worker/test/x.test.ts"]) {
      for (const code of [
        'await boss.getDb().executeSql("select 1");',
        "const db = boss.getDb();",
        'await db.executeSql("delete from people", []);',
        "const f = boss.getDb;",
        'const g = boss["getDb"];',
        'const h = db["executeSql"];',
        "const { getDb } = boss;",
        "const { executeSql: run } = db;",
        "await running.boss?.getDb()?.executeSql('select 1');",
      ]) {
        expect(await restricted(code, file), `${file}: ${code}`).not.toEqual([]);
      }
    }
  });

  // Review L7: handle.ts keeps its client map on globalThis under a Symbol.for key, so it
  // survives `next dev` reloads; apps may not look that key up.
  it("Symbol.for is rejected in apps/** (it would reach @vault/db's client map on globalThis)", async () => {
    for (const code of [
      'const map = (globalThis as never)[Symbol.for("@vault/db/clients")];',
      "const s = Symbol.for(key);",
      'const s = Symbol["for"]("@vault/db/clients");',
      "const { for: f } = Symbol;",
    ]) {
      for (const file of [SRC, "apps/worker/src/worker.ts", TEST]) expect(await restricted(code, file), `${file}: ${code}`).not.toEqual([]);
    }
  });

  // Review N1: guardrail against listing globalThis's symbol keys (production keeps no map there at all).
  it("Object.getOwnPropertySymbols, Reflect.ownKeys and Object.getOwnPropertyDescriptors are rejected in apps/**", async () => {
    for (const code of [
      "const keys = Object.getOwnPropertySymbols(globalThis);",
      "const keys = Reflect.ownKeys(globalThis);",
      "const all = Object.getOwnPropertyDescriptors(globalThis);",
      'const keys = Object["getOwnPropertySymbols"](globalThis);',
      'const keys = Reflect["ownKeys"](globalThis);',
      "const { getOwnPropertySymbols: f } = Object;",
      "const { ownKeys } = Reflect;",
    ]) {
      for (const file of [SRC, "apps/worker/src/worker.ts", TEST]) expect(await restricted(code, file), `${file}: ${code}`).not.toEqual([]);
    }
  });

  it("the web app's own getDb() (an opaque handle) is still allowed as a plain call", async () => {
    expect(await restricted('import { getDb } from "../../../../server/db.ts";\nexport const h = () => getDb();', "apps/web/src/app/api/v1/health/route.ts")).toEqual([]);
  });

  it("inline ESLint config comments have no effect in apps/** (L5: linterOptions.noInlineConfig), and still work everywhere else", async () => {
    const code = "// eslint-disable-next-line no-debugger\ndebugger;\n";
    const ruleIds = async (file: string) => {
      const [result] = await eslint.lintText(code, { filePath: path.join(repo, file) });
      return (result?.messages ?? []).map((m) => m.ruleId);
    };
    expect(await ruleIds("apps/web/src/x.ts")).toContain("no-debugger");
    expect(await ruleIds("apps/worker/test/x.test.ts")).toContain("no-debugger");
    expect(await ruleIds("packages/db/src/x.ts")).not.toContain("no-debugger");
    expect(await ruleIds("test/x.test.ts")).not.toContain("no-debugger");
  });

  it("every source file under apps/ is linted with the rule, whatever its extension (L7)", async () => {
    const NOT_CODE = /\.(json|md|css|scss|svg|png|jpe?g|gif|ico|webp|txt|ya?ml|webmanifest|woff2?)$|(^|\/)(Dockerfile|\.gitignore|\.dockerignore)$/;
    const tracked = execFileSync("git", ["ls-files", "apps"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean);
    const synthetic = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map((ext) => `apps/web/src/x.${ext}`);
    const files = [...tracked.filter((f) => !NOT_CODE.test(f)), ...synthetic];
    expect(files.length).toBeGreaterThan(synthetic.length);
    for (const file of files) {
      expect(await eslint.isPathIgnored(path.join(repo, file)), file).toBe(false);
      const config = (await eslint.calculateConfigForFile(path.join(repo, file))) as { rules?: Record<string, unknown> };
      expect(config.rules?.["no-restricted-imports"], file).toEqual(expect.arrayContaining([2]));
      expect(config.rules?.["no-restricted-syntax"], file).toEqual(expect.arrayContaining([2]));
    }
  });
});
