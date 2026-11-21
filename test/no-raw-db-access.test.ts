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
