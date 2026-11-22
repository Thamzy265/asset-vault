import { randomUUID } from "node:crypto";
import { getMigrations } from "better-auth/db/migration";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authOptions } from "../src/auth/options.ts";
import { createDb } from "../src/client.ts";
import { runAuditRetention } from "../src/index.ts";
import { migrateDown, migrateUp } from "../src/migrate.ts";
import type { Database } from "../src/schema.ts";
import { freshDatabase, type FreshDatabase } from "./support/fresh-database.ts";
import { migrateTo } from "./support/migrate.ts";

// M1.3 design note, Data: the auth tables are created by our own reversible migration
// (0007_auth), mirroring the schema of the pinned Better Auth version, not by its CLI.
const config = { appUrl: "http://127.0.0.1:3000", encryptionKey: "k".repeat(40), trustedIpHeader: null };
const AUTH_TABLES = ["auth_accounts", "auth_sessions", "auth_setup_tokens", "auth_sign_in_failures", "auth_two_factors", "auth_users", "auth_verifications"];

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

describe("0007_auth mirrors the pinned Better Auth schema", () => {
  it("Better Auth's own migration planner finds nothing to create, add or index, and no schema problem or type mismatch", async () => {
    const warnings: string[] = [];
    const plan = await getMigrations({
      ...authOptions(db, config),
      logger: { level: "warn", log: (level, message) => void (level === "warn" || level === "error" ? warnings.push(message) : undefined) },
    });
    expect(plan.toBeCreated.map((t) => t.table)).toEqual([]);
    expect(plan.toBeAdded.map((t) => ({ table: t.table, fields: Object.keys(t.fields) }))).toEqual([]);
    expect(plan.toBeAddedIndexes.map((i) => i.name)).toEqual([]);
    expect(plan.schemaProblems).toEqual([]);
    expect(plan.unsafeChanges).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("the pinned version is exact (package.json), so a library upgrade is a deliberate change with a new migration", async () => {
    const pkg = (await import("../package.json", { with: { type: "json" } })).default as { dependencies: Record<string, string> };
    expect(pkg.dependencies["better-auth"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("auth tables and users (item d: cascade, so retention never fails on a deactivated user)", () => {
  async function userWithEverything(deactivated: boolean) {
    const user = await db.insertInto("users").values({ role: "member", deactivated_at: deactivated ? new Date() : null }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("auth_users").values({ id: user.id, email: `${randomUUID()}@example.org`, name: "Someone" }).execute();
    const in1h = new Date(Date.now() + 3_600_000);
    await db.insertInto("auth_sessions").values({ user_id: user.id, token: randomUUID(), expires_at: in1h }).execute();
    await db.insertInto("auth_accounts").values({ user_id: user.id, account_id: user.id, provider_id: "credential", password: "x:y" }).execute();
    await db.insertInto("auth_two_factors").values({ user_id: user.id, secret: "s", backup_codes: "[]" }).execute();
    await db.insertInto("auth_setup_tokens").values({ user_id: user.id, token_hash: randomUUID(), expires_at: in1h }).execute();
    return user.id;
  }
  const countFor = async (userId: string) => {
    const { rows } = await sql<{ n: number }>`
      select (select count(*) from auth_sessions where user_id = ${userId})
        + (select count(*) from auth_accounts where user_id = ${userId})
        + (select count(*) from auth_two_factors where user_id = ${userId})
        + (select count(*) from auth_setup_tokens where user_id = ${userId})
        + (select count(*) from auth_users where id = ${userId}) as n`.execute(db);
    return Number(rows[0]!.n);
  };

  it("every foreign key from an auth table is ON DELETE CASCADE: auth_users to users, the rest to auth_users", async () => {
    const { rows } = await sql<{ from: string; to: string; rule: string }>`
      select c.conrelid::regclass::text as from, c.confrelid::regclass::text as to,
        case c.confdeltype when 'c' then 'CASCADE' when 'r' then 'RESTRICT' when 'n' then 'SET NULL' when 'a' then 'NO ACTION' else c.confdeltype::text end as rule
      from pg_constraint c where c.contype = 'f' and c.conrelid::regclass::text like 'auth\\_%' order by 1`.execute(db);
    expect(rows).toEqual([
      { from: "auth_accounts", to: "auth_users", rule: "CASCADE" },
      { from: "auth_sessions", to: "auth_users", rule: "CASCADE" },
      { from: "auth_setup_tokens", to: "auth_users", rule: "CASCADE" },
      { from: "auth_two_factors", to: "auth_users", rule: "CASCADE" },
      { from: "auth_users", to: "users", rule: "CASCADE" },
    ]);
  });

  it("retention deletes a deactivated user with a row in every auth table, and the rows go with it", async () => {
    const leaver = await userWithEverything(true);
    const active = await userWithEverything(false);
    expect(await countFor(leaver)).toBe(5);
    expect(await runAuditRetention(db)).toMatchObject({ usersDeleted: 1 });
    expect(await countFor(leaver)).toBe(0);
    expect(await countFor(active)).toBe(5);
  });

  it("an auth_users row needs its users row (same id); emails are unique and lower case; names are 1-100 characters", async () => {
    const insert = async (email: string, name = "N") => {
      const user = await db.insertInto("users").values({ role: "member" }).returning("id").executeTakeFirstOrThrow();
      return sql`insert into auth_users (id, email, name) values (${user.id}, ${email}, ${name})`.execute(db).then(() => "ok", (e: { code?: string }) => e.code);
    };
    expect(await sql`insert into auth_users (id, email, name) values (${randomUUID()}, 'orphan@example.org', 'N')`.execute(db).then(() => "ok", (e: { code?: string }) => e.code)).toBe("23503");
    expect(await insert("same@example.org")).toBe("ok");
    expect(await insert("same@example.org")).toBe("23505");
    expect(await insert("Upper@Example.org")).toBe("23514");
    expect(await insert("blank-name@example.org", "")).toBe("23514");
    expect(await insert("long-name@example.org", "n".repeat(101))).toBe("23514");
  });

  it("a user has at most one two-factor row, and session tokens and setup-token hashes are unique", async () => {
    const id = await userWithEverything(false);
    await expect(db.insertInto("auth_two_factors").values({ user_id: id, secret: "t", backup_codes: "[]" }).execute()).rejects.toMatchObject({ code: "23505" });
    const token = (await db.selectFrom("auth_sessions").select("token").where("user_id", "=", id).executeTakeFirstOrThrow()).token;
    await expect(db.insertInto("auth_sessions").values({ user_id: id, token, expires_at: new Date() }).execute()).rejects.toMatchObject({ code: "23505" });
  });
});

describe("0007_auth down and up", () => {
  it("down drops the auth tables and leaves users as it was; up restores them", async () => {
    const own = await freshDatabase();
    const m = createDb(own.url);
    const tables = async () =>
      (await sql<{ t: string }>`select table_name as t from information_schema.tables where table_schema = 'public' and table_name like 'auth\\_%' order by 1`.execute(m)).rows.map((r) => r.t);
    const userColumns = async () =>
      (await sql<{ c: string }>`select column_name as c from information_schema.columns where table_name = 'users' order by 1`.execute(m)).rows.map((r) => r.c);
    try {
      await migrateTo(m, "0007_auth");
      expect(await tables()).toEqual(AUTH_TABLES);
      expect(await userColumns()).toEqual(["created_at", "deactivated_at", "id", "person_id", "role", "updated_at"]);
      expect(await migrateDown(m)).toEqual(["0007_auth"]);
      expect(await tables()).toEqual([]);
      await migrateTo(m, "0007_auth");
      expect(await tables()).toEqual(AUTH_TABLES);
    } finally {
      await m.destroy();
      await own.drop();
    }
  });
});
