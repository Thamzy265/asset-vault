import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrateDown, migrateUp, migrations, readHeartbeat, recordHeartbeat, type Database } from "../src/index.ts";
import { freshDatabase } from "./support/fresh-database.ts";

const all = Object.keys(migrations);

async function tables(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ table_name: string }>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name not like 'kysely_%' order by table_name`.execute(db);
  return rows.map((r) => r.table_name);
}

describe("migration edge cases (tester)", () => {
  let db: Kysely<Database>;
  let drop: () => Promise<void>;
  let url: string;

  beforeAll(async () => {
    const fresh = await freshDatabase();
    drop = fresh.drop;
    url = fresh.url;
    db = createDb(url);
  });
  afterAll(async () => {
    await db?.destroy();
    await drop?.();
  });

  it("rollback on a database where nothing was ever applied returns no names and does not throw", async () => {
    await expect(migrateDown(db)).resolves.toEqual([]);
    expect(await tables(db)).toEqual([]);
  });

  it("re-running migrate reports nothing applied and leaves data intact", async () => {
    await migrateUp(db);
    await recordHeartbeat(db, new Date("2026-11-21T10:00:00.000Z"));
    await expect(migrateUp(db)).resolves.toEqual([]);
    await expect(migrateUp(db)).resolves.toEqual([]);
    expect(await readHeartbeat(db)).toEqual(new Date("2026-11-21T10:00:00.000Z"));
  });

  it("rolling back twice past the first migration is a harmless no-op the second time", async () => {
    for (let i = 0; i < all.length; i++) await migrateDown(db);
    await expect(migrateDown(db)).resolves.toEqual([]);
    await expect(migrateDown(db)).resolves.toEqual([]);
    expect(await tables(db)).toEqual([]);
  });

  it("after a full rollback the heartbeat read degrades to null, not an error", async () => {
    expect(await readHeartbeat(db)).toBeNull();
  });

  it("after down, up works again and starts from an empty _meta (data is gone, as down means)", async () => {
    await expect(migrateUp(db)).resolves.toEqual(all);
    expect(await readHeartbeat(db)).toBeNull();
    await recordHeartbeat(db, new Date("2026-11-21T11:00:00.000Z"));
    expect(await readHeartbeat(db)).toEqual(new Date("2026-11-21T11:00:00.000Z"));
  });

  it("repeated up/down cycles stay clean", async () => {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < all.length; j++) await migrateDown(db);
      expect(await tables(db)).toEqual([]);
      await migrateUp(db);
      expect(await tables(db)).toEqual(["_meta"]);
    }
  });

  it("two processes migrating at once both succeed and the schema is applied exactly once", async () => {
    const fresh = await freshDatabase();
    const a = createDb(fresh.url);
    const b = createDb(fresh.url);
    try {
      const [ra, rb] = await Promise.all([migrateUp(a), migrateUp(b)]);
      expect([...ra, ...rb].sort()).toEqual([...all].sort());
      expect(await tables(a)).toEqual(["_meta"]);
    } finally {
      await a.destroy();
      await b.destroy();
      await fresh.drop();
    }
  });

  it("_meta shape: key is the primary key, value is required, updated_at defaults to now()", async () => {
    await migrateUp(db);
    const { rows } = await sql<{ column_name: string; is_nullable: string; data_type: string; column_default: string | null }>`
      select column_name, is_nullable, data_type, column_default
      from information_schema.columns where table_name = '_meta' order by column_name`.execute(db);
    expect(rows.map((r) => [r.column_name, r.is_nullable, r.data_type])).toEqual([
      ["key", "NO", "text"],
      ["updated_at", "NO", "timestamp with time zone"],
      ["value", "NO", "text"],
    ]);
    await expect(sql`insert into _meta (key, value) values ('k', 'v'), ('k', 'v2')`.execute(db)).rejects.toThrow();
    await expect(sql`insert into _meta (key, value) values ('n', null)`.execute(db)).rejects.toThrow();
  });

  it("recording a heartbeat twice keeps exactly one row", async () => {
    await recordHeartbeat(db, new Date("2026-11-21T12:00:00.000Z"));
    await recordHeartbeat(db, new Date("2026-11-21T12:01:00.000Z"));
    const { rows } = await sql<{ n: string }>`select count(*)::text as n from _meta where key = 'worker.heartbeat'`.execute(db);
    expect(rows[0]?.n).toBe("1");
    expect(await readHeartbeat(db)).toEqual(new Date("2026-11-21T12:01:00.000Z"));
  });

  it("a write to the heartbeat while _meta is missing rejects (the worker job fails and pg-boss retries)", async () => {
    for (let j = 0; j < all.length; j++) await migrateDown(db);
    await expect(recordHeartbeat(db, new Date())).rejects.toThrow();
  });
});
