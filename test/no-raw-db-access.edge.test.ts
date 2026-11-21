import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import * as publicApi from "../packages/db/src/index.ts";

// Tester (M1.2): can raw database access sneak into apps/** past the ESLint rule?
// Design note, top quality "Authorisation": "lint rule or test that forbids importing the raw
// Kysely client outside packages/db". L1-L7 were CONFIRMED BYPASSES; they are closed now (the
// assertions state what must happen, and the markers are gone).
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({ cwd: repo });

async function flagged(code: string, filePath: string): Promise<boolean> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repo, filePath) });
  return (result?.messages ?? []).some((m) => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax");
}

const FILES = ["apps/web/src/server/x.ts", "apps/worker/src/x.ts", "apps/web/src/app/api/v1/x/route.ts", "apps/web/test/x.test.ts", "apps/worker/src/x.js"];

describe("rejected in every app file shape", () => {
  it.each([
    ['import type { Kysely } from "kysely";', "type-only import"],
    ['import { type Kysely } from "kysely";', "inline type import"],
    ['import "kysely";', "side-effect import"],
    ['import * as k from "kysely";', "namespace import"],
    ['export * from "kysely";', "export star"],
    ['export * as k from "pg";', "export star as"],
    ['export { Pool } from "pg";', "named re-export"],
    ['import pg from "pg"; export default pg;', "default re-export of pg"],
    ['import { Pool } from "pg-pool";', "pg-pool"],
    ['import { sql } from "kysely/helpers/postgres";', "kysely helpers subpath"],
    ['import x from "../../../../packages/db/src";', "relative dir import of packages/db/src"],
    ['import x from "../../../../packages/db/src/index.ts";', "relative index.ts"],
    ['import x from "../../../../packages/db/src/handle.ts";', "kyselyOf lives in handle.ts"],
    ['import x from "@vault/db/src/handle.ts";', "package deep import"],
    ['const k = await import("../../../../packages/db/src/handle.ts");', "dynamic relative"],
    ['const k = await import("pg");', "dynamic pg"],
  ])("%s (%s)", async (code) => {
    for (const file of FILES) expect(await flagged(code, file), file).toBe(true);
  });

  it("is not triggered by look-alike module names that are not the database packages", async () => {
    expect(await flagged('import x from "pgp-utils";', "apps/web/src/x.ts")).toBe(false);
    expect(await flagged('import x from "kysely-like";', "apps/web/src/x.ts")).toBe(false);
  });
});

describe("formerly confirmed bypasses L1-L7: rejected now", () => {
  it("L1: a template-literal dynamic import of kysely is rejected", async () => {
    expect(await flagged("const k = await import(`kysely`);", "apps/web/src/x.ts")).toBe(true);
  });

  it("L2: a computed dynamic import (string concatenation) of kysely is rejected", async () => {
    expect(await flagged('const k = await import("ky" + "sely");', "apps/web/src/x.ts")).toBe(true);
  });

  it("L3: createRequire / require of kysely is rejected", async () => {
    expect(await flagged('import { createRequire } from "node:module";\nconst k = createRequire(import.meta.url)("kysely");', "apps/worker/src/x.ts")).toBe(true);
    expect(await flagged('const k = require("kysely");', "apps/worker/src/x.js")).toBe(true);
  });

  it("L4: a path into packages/db/src that is not written canonically ('./src', '//src', '../db/src') is rejected", async () => {
    for (const spec of ["../../../../packages/db/./src/handle.ts", "../../../../packages/db//src/handle.ts", "../../../../packages/db/../db/src/handle.ts", "../../../../packages/./db/src/handle.ts"]) {
      expect(await flagged(`import x from "${spec}";`, "apps/web/src/server/x.ts"), spec).toBe(true);
    }
  });

  it("L5: an inline eslint-disable comment cannot silence the rule inside apps/**", async () => {
    expect(await flagged('// eslint-disable-next-line no-restricted-imports\nimport { Kysely } from "kysely";', "apps/web/src/x.ts")).toBe(true);
    expect(await flagged('/* eslint-disable */\nimport { Kysely } from "kysely";', "apps/web/src/x.ts")).toBe(true);
  });

  it("L6: the test-support raw SQL helper (packages/db/test/support/raw-sql.ts, pg inside) cannot be imported from app production code", async () => {
    expect(await flagged('import { rawQuery } from "../../../../packages/db/test/support/raw-sql.ts";', "apps/web/src/server/x.ts")).toBe(true);
  });

  it("L7: .mts, .cts and .jsx files under apps/** are covered as well", async () => {
    for (const file of ["apps/web/src/x.mts", "apps/worker/src/x.cts", "apps/web/src/x.jsx"]) {
      expect(await flagged('import { Kysely } from "kysely";', file), file).toBe(true);
    }
  });
});

describe("what @vault/db exports to apps (regression lock)", () => {
  // Regression lock: apps may use ONLY these names. Adding an export must be a conscious choice,
  // because a raw client, pool or query builder leaking out of index.ts defeats the visibility layer.
  // It could break whenever someone re-exports a helper "for convenience".
  it("the public export list is exactly the reviewed one", () => {
    expect(Object.keys(publicApi).sort()).toEqual(
      [
        "ConfigError",
        "DatabaseUnavailableError",
        "EXPECTED_SCHEMA_VERSION",
        "ForbiddenError",
        "NotFoundError",
        "PersonInUseError",
        "closeDatabase",
        "createAuthService",
        "errorCode",
        "errorFields",
        "loadAuthConfig",
        "loadDbConfig",
        "log",
        "openDatabase",
        "peopleRepository",
        "pingDatabase",
        "readHeartbeat",
        "readSchemaVersion",
        "recordHeartbeat",
        "runAuditRetention",
        "ValidationError",
        "waitForDatabase",
        "waitForDatabaseReady",
      ].sort(),
    );
  });

  it("the auth service (M1.3) hands apps two functions only: no library instance, adapter or client", () => {
    const handle = publicApi.openDatabase("postgres://u@127.0.0.1:1/none");
    try {
      const auth = publicApi.createAuthService(handle, { appUrl: "http://127.0.0.1:3000", encryptionKey: "k".repeat(40), trustedIpHeader: null });
      expect(Object.keys(auth).sort()).toEqual(["handle", "session"]);
      expect(Object.values(auth).every((v) => typeof v === "function")).toBe(true);
    } finally {
      void publicApi.closeDatabase(handle);
    }
  });

  it("no exported function hands back a query builder: a handle opened by an app cannot be used as a Kysely client", async () => {
    const handle = publicApi.openDatabase("postgres://u@127.0.0.1:1/none");
    try {
      for (const method of ["selectFrom", "insertInto", "updateTable", "deleteFrom", "executeQuery", "withSchema", "schema", "getExecutor", "destroy"]) {
        expect((handle as unknown as Record<string, unknown>)[method], method).toBeUndefined();
      }
      expect(Object.isFrozen(handle)).toBe(true);
      expect(() => Object.assign(handle, { selectFrom: () => 1 })).toThrow();
    } finally {
      await publicApi.closeDatabase(handle).catch(() => {});
    }
  });

  it("a forged handle (a plain object that looks like one) is refused by every exported function that takes a database", async () => {
    const forged = { kind: "vault-db" } as unknown as publicApi.DbHandle;
    await expect(publicApi.pingDatabase(forged)).rejects.toThrow(TypeError);
    await expect(publicApi.readSchemaVersion(forged)).rejects.toThrow(TypeError);
    await expect(publicApi.runAuditRetention(forged)).rejects.toThrow(TypeError);
    expect(() => publicApi.peopleRepository(forged)).toThrow(TypeError);
  });
});
