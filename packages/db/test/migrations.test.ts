import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrateDown, migrateUp, migrations, type Database } from "../src/index.ts";
import { freshDatabase } from "./support/fresh-database.ts";

async function publicTables(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ table_name: string }>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name not like 'kysely_%'
    order by table_name`.execute(db);
  return rows.map((r) => r.table_name);
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
    expect(await publicTables(db)).toEqual(["_meta"]);

    for (let i = 0; i < Object.keys(migrations).length; i++) {
      await migrateDown(db);
    }
    expect(await publicTables(db)).toEqual([]);

    await migrateUp(db);
    expect(await publicTables(db)).toEqual(["_meta"]);
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
