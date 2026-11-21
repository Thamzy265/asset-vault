import { sql, type Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { migrateDown, migrateUp, migrations } from "../src/index.ts";
import type { Database } from "../src/schema.ts";
import { freshDatabase } from "./support/fresh-database.ts";

const ALL_TABLES = ["_meta", "audit_log", "people", "users"];

async function publicTables(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ table_name: string }>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name not like 'kysely_%'
    order by table_name`.execute(db);
  return rows.map((r) => r.table_name);
}

/** Tables, functions and triggers in public, except Kysely's own bookkeeping. */
async function publicObjects(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    select 'table ' || table_name as name from information_schema.tables
      where table_schema = 'public' and table_name not like 'kysely_%'
    union all
    select 'function ' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
    union all
    select 'trigger ' || t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal
    order by 1`.execute(db);
  return rows.map((r) => r.name);
}

describe("migrations", () => {
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

  it("every migration has an explicit up and down", () => {
    const entries = Object.entries(migrations);
    expect(entries.length).toBeGreaterThan(0);
    for (const [, migration] of entries) {
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    }
  });

  it("go up, all the way down, and up again cleanly", async () => {
    const applied = await migrateUp(db);
    expect(applied).toEqual(Object.keys(migrations));
    expect(await publicTables(db)).toEqual(ALL_TABLES);

    for (let i = 0; i < Object.keys(migrations).length; i++) {
      await migrateDown(db);
    }
    expect(await publicTables(db)).toEqual([]);

    await migrateUp(db);
    expect(await publicTables(db)).toEqual(ALL_TABLES);
  });

  it("each migration goes up -> down -> up cleanly on its own, one step at a time from the top", async () => {
    await migrateUp(db);
    const names = Object.keys(migrations);
    for (let i = names.length - 1; i >= 0; i--) {
      const before = await publicObjects(db);
      expect(await migrateDown(db)).toEqual([names[i]]);
      const step = await new Migrator({ db, provider: { getMigrations: async () => migrations } }).migrateUp();
      expect(step.error).toBeUndefined();
      expect(step.results?.map((r) => r.migrationName)).toEqual([names[i]]);
      expect(await publicObjects(db)).toEqual(before);
      await migrateDown(db);
    }
    expect(await publicObjects(db)).toEqual([]);
    await migrateUp(db);
  });

  it("a full rollback leaves no tables, functions or triggers behind", async () => {
    await migrateUp(db);
    for (let i = 0; i < Object.keys(migrations).length; i++) await migrateDown(db);
    expect(await publicObjects(db)).toEqual([]);
    await migrateUp(db);
  });

  it("migrateUp is a no-op when already at the latest version", async () => {
    await migrateUp(db);
    expect(await migrateUp(db)).toEqual([]);
  });

  it("migrateDown with nothing applied does nothing", async () => {
    const fresh = await freshDatabase();
    const empty = createDb(fresh.url);
    try {
      expect(await migrateDown(empty)).toEqual([]);
    } finally {
      await empty.destroy();
      await fresh.drop();
    }
  });
});
