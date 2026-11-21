import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { runAuditRetention } from "../src/index.ts";
import { migrateDown, migrateUp } from "../src/migrate.ts";
import { migrations } from "../src/migrations/index.ts";
import type { Database } from "../src/schema.ts";
import { freshDatabase, type FreshDatabase } from "./support/fresh-database.ts";

// M1.3 carried item C1: deactivation ships, so the nightly retention now deletes user rows.
// people.created_by_user_id / updated_by_user_id are ON DELETE SET NULL; that cascade is an
// UPDATE of the people row, and it must not move updated_at (a change nobody made, with no
// audit row). Migration 0005 makes set_updated_at() ignore changes that touch only
// *_by_user_id columns.
let fresh: FreshDatabase;
let db: Kysely<Database>;
beforeAll(async () => {
  fresh = await freshDatabase();
  db = createDb(fresh.url);
  await migrateUp(db);
});
afterAll(async () => {
  await db?.destroy();
  await fresh?.drop();
});

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
const updatedAt = async (id: string) =>
  (await sql<{ t: string }>`select updated_at::text as t from people where id = ${id}`.execute(db)).rows[0]!.t;
const pause = () => sql`select pg_sleep(0.01)`.execute(db);

async function personMadeBy(userId: string): Promise<string> {
  const row = await db
    .insertInto("people")
    .values({ display_name: "Made by a leaver", created_by_user_id: userId, updated_by_user_id: userId })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

describe("updated_at and the *_by_user_id columns (C1)", () => {
  it("retention deleting a deactivated user clears created_by/updated_by but leaves updated_at alone", async () => {
    const leaver = (await db.insertInto("users").values({ role: "member", deactivated_at: daysAgo(1) }).returning("id").executeTakeFirstOrThrow()).id;
    const id = await personMadeBy(leaver);
    const before = await updatedAt(id);
    await pause();
    expect(await runAuditRetention(db)).toMatchObject({ usersDeleted: 1 });
    const row = await db.selectFrom("people").select(["created_by_user_id", "updated_by_user_id"]).where("id", "=", id).executeTakeFirstOrThrow();
    expect(row).toEqual({ created_by_user_id: null, updated_by_user_id: null });
    expect(await updatedAt(id)).toBe(before);
  });

  it("an UPDATE that changes only updated_by_user_id does not move updated_at", async () => {
    const user = (await db.insertInto("users").values({ role: "member" }).returning("id").executeTakeFirstOrThrow()).id;
    const id = await personMadeBy(user);
    const before = await updatedAt(id);
    await pause();
    await sql`update people set updated_by_user_id = null where id = ${id}`.execute(db);
    expect(await updatedAt(id)).toBe(before);
  });

  it("a real change together with updated_by_user_id still moves updated_at", async () => {
    const user = (await db.insertInto("users").values({ role: "member" }).returning("id").executeTakeFirstOrThrow()).id;
    const id = await personMadeBy(user);
    const before = await updatedAt(id);
    await pause();
    await sql`update people set relationship = 'cousin', updated_by_user_id = null where id = ${id}`.execute(db);
    expect((await updatedAt(id)) > before).toBe(true);
  });

  it("updated_at still can't be forged: an UPDATE naming only updated_at keeps the old value", async () => {
    const user = (await db.insertInto("users").values({ role: "member" }).returning("id").executeTakeFirstOrThrow()).id;
    const id = await personMadeBy(user);
    const before = await updatedAt(id);
    await sql`update people set updated_at = '2000-01-01T00:00:00Z' where id = ${id}`.execute(db);
    expect(await updatedAt(id)).toBe(before);
  });

  it("users rows still move updated_at on a real change (the trigger is shared)", async () => {
    const id = (await db.insertInto("users").values({ role: "member" }).returning("id").executeTakeFirstOrThrow()).id;
    const read = async () => (await sql<{ t: string }>`select updated_at::text as t from users where id = ${id}`.execute(db)).rows[0]!.t;
    const before = await read();
    await pause();
    await sql`update users set role = 'admin' where id = ${id}`.execute(db);
    expect((await read()) > before).toBe(true);
  });

  it("rolling back 0005 restores the old trigger (any UPDATE moves updated_at); up again restores the new one", async () => {
    const own = await freshDatabase();
    const m = createDb(own.url);
    try {
      const names = Object.keys(migrations);
      const target = names.indexOf("0005_updated_at_by_user");
      expect(target).toBeGreaterThan(-1);
      await migrateUp(m);
      for (let i = names.length - 1; i >= target; i--) await migrateDown(m);
      const user = (await m.insertInto("users").values({ role: "member" }).returning("id").executeTakeFirstOrThrow()).id;
      const id = (await m.insertInto("people").values({ display_name: "x", updated_by_user_id: user }).returning("id").executeTakeFirstOrThrow()).id;
      const read = async () => (await sql<{ t: string }>`select updated_at::text as t from people where id = ${id}`.execute(m)).rows[0]!.t;
      let before = await read();
      await sql`select pg_sleep(0.01)`.execute(m);
      await sql`update people set updated_by_user_id = null where id = ${id}`.execute(m);
      expect((await read()) > before).toBe(true);
      await migrateUp(m);
      before = await read();
      await sql`select pg_sleep(0.01)`.execute(m);
      await sql`update people set updated_by_user_id = ${user} where id = ${id}`.execute(m);
      expect(await read()).toBe(before);
    } finally {
      await m.destroy();
      await own.drop();
    }
  });
});
