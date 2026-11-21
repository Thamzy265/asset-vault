import { closeDatabase, openDatabase, recordHeartbeat } from "@vault/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../packages/db/test/support/fresh-database.ts";
import { migrateDown, migrateUp, migrations } from "../../../packages/db/test/support/migrate.ts";
import { getHealth, healthResponse } from "../src/server/health.ts";
import pkg from "../package.json" with { type: "json" };

const LATEST = "0004_database_roles";
const schemaOk = { readSchemaVersion: async () => LATEST, expectedSchemaVersion: LATEST };

describe("getHealth", () => {
  const heartbeat = new Date("2026-11-21T10:00:00.000Z");

  it("is 200 ok with version, schema versions and last worker heartbeat when the database answers at the expected schema", async () => {
    const result = await getHealth({ ping: async () => {}, readHeartbeat: async () => heartbeat, version: "1.2.3", ...schemaOk });
    expect(result).toEqual({
      httpStatus: 200,
      body: {
        status: "ok",
        db: "ok",
        version: "1.2.3",
        schema: { expected: LATEST, applied: LATEST },
        workerHeartbeat: "2026-11-21T10:00:00.000Z",
      },
    });
  });

  it("is 503 with db down when the ping fails, and reads neither the heartbeat nor the schema", async () => {
    const read: string[] = [];
    const result = await getHealth({
      ping: async () => { throw new Error("ECONNREFUSED"); },
      readHeartbeat: async () => { read.push("heartbeat"); return heartbeat; },
      readSchemaVersion: async () => { read.push("schema"); return LATEST; },
      expectedSchemaVersion: LATEST,
      version: "1.2.3",
    });
    expect(result).toEqual({
      httpStatus: 503,
      body: { status: "error", db: "down", version: "1.2.3", schema: { expected: LATEST, applied: null }, workerHeartbeat: null },
    });
    expect(read).toEqual([]);
  });

  it("stays 200 when the heartbeat cannot be read (worker state does not decide health)", async () => {
    const result = await getHealth({
      ping: async () => {},
      readHeartbeat: async () => { throw new Error("boom"); },
      version: "1.2.3",
      ...schemaOk,
    });
    expect(result.httpStatus).toBe(200);
    expect(result.body.workerHeartbeat).toBeNull();
  });

  // Migration gate (review L7): code and database must agree on the schema.
  it.each([
    ["older than the code (a migration did not run)", "0002_people_users"],
    ["newer than the code (rolled-back image, schema not rolled back)", "0004_future"],
    ["missing (never migrated)", null],
  ])("is 503 when the applied schema is %s", async (_label, applied) => {
    const result = await getHealth({
      ping: async () => {},
      readHeartbeat: async () => heartbeat,
      readSchemaVersion: async () => applied,
      expectedSchemaVersion: LATEST,
      version: "1.2.3",
    });
    expect(result.httpStatus).toBe(503);
    expect(result.body).toMatchObject({ status: "error", db: "ok", schema: { expected: LATEST, applied } });
  });

  it("is 503 when the schema version can't be read", async () => {
    const result = await getHealth({
      ping: async () => {},
      readHeartbeat: async () => heartbeat,
      readSchemaVersion: async () => { throw new Error("boom"); },
      expectedSchemaVersion: LATEST,
      version: "1.2.3",
    });
    expect(result.httpStatus).toBe(503);
    expect(result.body.schema).toEqual({ expected: LATEST, applied: null });
  });
});

// As in Compose: migrations run as vault_migrator (url), the web app reads as vault_app (appUrl).
describe("healthResponse (real Postgres)", () => {
  let url: string;
  let appUrl: string;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ url, appUrl, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());

  async function migrate(step: "up" | "down") {
    const migrator = openDatabase(url);
    try {
      return step === "up" ? await migrateUp(migrator) : await migrateDown(migrator);
    } finally {
      await closeDatabase(migrator);
    }
  }

  it("returns 200 JSON, never cached, with the app version", async () => {
    const db = openDatabase(appUrl);
    try {
      await migrate("up");
      await recordHeartbeat(db, new Date("2026-11-21T10:00:00.000Z"));
      const res = await healthResponse(db);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({
        status: "ok",
        db: "ok",
        version: pkg.version,
        schema: { expected: LATEST, applied: LATEST },
        workerHeartbeat: "2026-11-21T10:00:00.000Z",
      });
    } finally {
      await closeDatabase(db);
    }
  });

  it("returns 503 after one migration is rolled back, and 200 again once it is re-applied", async () => {
    const db = openDatabase(appUrl);
    try {
      await migrate("up");
      expect(await migrate("down")).toEqual([LATEST]);
      // Rolling back 0004 also takes back the app role's right to read the schema version.
      const res = await healthResponse(db);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: "error", db: "ok", schema: { expected: LATEST, applied: null } });
      await migrate("up");
      expect((await healthResponse(db)).status).toBe(200);
    } finally {
      await closeDatabase(db);
    }
  });

  it("returns 503 on a database that was never migrated", async () => {
    const fresh = await freshDatabase();
    const db = openDatabase(fresh.appUrl);
    try {
      const res = await healthResponse(db);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ db: "ok", schema: { expected: LATEST, applied: null } });
    } finally {
      await closeDatabase(db);
      await fresh.drop();
    }
  });

  it("the expected version is the last migration in the code", () => {
    expect(Object.keys(migrations).at(-1)).toBe(LATEST);
  });

  it("returns 503 with db down when Postgres is unreachable", async () => {
    const db = openDatabase("postgres://127.0.0.1:1/unreachable");
    try {
      const res = await healthResponse(db);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: "error", db: "down" });
    } finally {
      await closeDatabase(db);
    }
  });
});
