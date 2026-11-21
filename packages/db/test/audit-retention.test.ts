import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { runAuditRetention } from "../src/index.ts";
import { migrateUp } from "../src/migrate.ts";
import type { Database } from "../src/schema.ts";
import { freshDatabase } from "./support/fresh-database.ts";

describe("runAuditRetention", () => {
  let db: Kysely<Database>;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const fresh = await freshDatabase();
    drop = fresh.drop;
    db = createDb(fresh.url);
    await migrateUp(db);
  });
  afterAll(async () => {
    await db?.destroy();
    await drop?.();
  });

  it("returns how many rows it deleted and how many ip prefixes it cleared, as numbers", async () => {
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
    await sql`insert into audit_log (action, at, ip_prefix) values
      ('sign_in', ${daysAgo(800)}, null),
      ('sign_in', ${daysAgo(100)}, '10.0.0.0/24'),
      ('sign_in', ${daysAgo(1)}, '10.0.1.0/24')`.execute(db);
    expect(await runAuditRetention(db)).toEqual({ deleted: 1, ipPrefixesCleared: 1, usersDeleted: 0 });
    expect(await runAuditRetention(db)).toEqual({ deleted: 0, ipPrefixesCleared: 0, usersDeleted: 0 });
  });

  // Decision 8: users are deactivated, not deleted; the retention job deletes a deactivated
  // user's row once its last audit row has expired.
  describe("deactivated users (decision 8, B3)", () => {
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
    const newUser = async (deactivatedAt: Date | null) =>
      (await db.insertInto("users").values({ role: "member", deactivated_at: deactivatedAt }).returning("id").executeTakeFirstOrThrow()).id;
    const exists = async (id: string) => (await db.selectFrom("users").select("id").where("id", "=", id).executeTakeFirst()) !== undefined;

    it("users.deactivated_at is a nullable timestamptz, null for a new user", async () => {
      const { rows } = await sql<{ is_nullable: string; data_type: string; column_default: string | null }>`
        select is_nullable, data_type, column_default from information_schema.columns
        where table_name = 'users' and column_name = 'deactivated_at'`.execute(db);
      expect(rows).toEqual([{ is_nullable: "YES", data_type: "timestamp with time zone", column_default: null }]);
      const created = await db.insertInto("users").values({ role: "member" }).returning("deactivated_at").executeTakeFirstOrThrow();
      expect(created.deactivated_at).toBeNull();
    });

    it("deletes a deactivated user whose last audit row has expired, together with that row; records they made keep existing with created_by null", async () => {
      const leaver = await newUser(daysAgo(30));
      const made = await db.insertInto("people").values({ display_name: "Made by leaver", created_by_user_id: leaver }).returning("id").executeTakeFirstOrThrow();
      await sql`insert into audit_log (actor_user_id, action, at) values (${leaver}, 'sign_out', ${daysAgo(800)}), (${leaver}, 'sign_in', ${daysAgo(760)})`.execute(db);
      expect(await runAuditRetention(db)).toEqual({ deleted: 2, ipPrefixesCleared: 0, usersDeleted: 1 });
      expect(await exists(leaver)).toBe(false);
      const row = await db.selectFrom("people").select("created_by_user_id").where("id", "=", made.id).executeTakeFirstOrThrow();
      expect(row.created_by_user_id).toBeNull();
    });

    it("keeps a deactivated user while any of their audit rows is younger than 2 years", async () => {
      const leaver = await newUser(daysAgo(30));
      await sql`insert into audit_log (actor_user_id, action, at) values (${leaver}, 'sign_out', ${daysAgo(800)}), (${leaver}, 'sign_out', ${daysAgo(10)})`.execute(db);
      expect(await runAuditRetention(db)).toMatchObject({ deleted: 1, usersDeleted: 0 });
      expect(await exists(leaver)).toBe(true);
    });

    it("deletes a deactivated user who has no audit rows at all, and never an active user", async () => {
      const leaver = await newUser(daysAgo(1));
      const active = await newUser(null);
      expect(await runAuditRetention(db)).toMatchObject({ usersDeleted: 1 });
      expect(await exists(leaver)).toBe(false);
      expect(await exists(active)).toBe(true);
    });
  });
});
