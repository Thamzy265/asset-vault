import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { pingDatabase, readHeartbeat, recordHeartbeat } from "../src/index.ts";
import { migrateUp } from "../src/migrate.ts";
import type { Database } from "../src/schema.ts";
import { freshDatabase } from "./support/fresh-database.ts";

describe("heartbeat and ping", () => {
  let db: Kysely<Database>;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const fresh = await freshDatabase();
    drop = fresh.drop;
    db = createDb(fresh.url);
  });

  afterAll(async () => {
    await db?.destroy();
    await drop?.();
  });

  it("readHeartbeat returns null before migrations have run", async () => {
    expect(await readHeartbeat(db)).toBeNull();
  });

  it("readHeartbeat returns null before the first heartbeat", async () => {
    await migrateUp(db);
    expect(await readHeartbeat(db)).toBeNull();
  });

  it("records the last run time and keeps only the latest", async () => {
    await recordHeartbeat(db, new Date("2026-11-21T10:00:00.000Z"));
    await recordHeartbeat(db, new Date("2026-11-21T10:01:00.000Z"));
    expect((await readHeartbeat(db))?.toISOString()).toBe("2026-11-21T10:01:00.000Z");
  });

  it("pingDatabase resolves when Postgres answers", async () => {
    await expect(pingDatabase(db)).resolves.toBeUndefined();
  });

  it("pingDatabase rejects quickly when Postgres is unreachable", async () => {
    const dead = createDb("postgres://127.0.0.1:1/unreachable");
    const started = Date.now();
    await expect(pingDatabase(dead)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    await dead.destroy();
  });
});
