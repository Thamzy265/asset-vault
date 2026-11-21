import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { readHeartbeat, recordHeartbeat, runAuditRetention, type Viewer } from "../src/index.ts";
import { migrateDown, migrateUp } from "../src/migrate.ts";
import { migrations } from "../src/migrations/index.ts";
import { peopleRepository } from "../src/people.ts";
import type { Database } from "../src/schema.ts";
import { readSchemaVersion } from "../src/schema-version.ts";
import { migrateTo } from "./support/migrate.ts";
import { freshDatabase, type FreshDatabase } from "./support/fresh-database.ts";

// M1.2 decision 3: two database roles. vault_migrator owns the database and the schema and runs
// migrations; vault_app (web and worker) is not a superuser, owns nothing, and gets only what
// migration 0004 grants. The roles come from packages/db/initdb/10-vault-roles.sh, which the test
// container runs exactly as the Compose postgres service does.
let fresh: FreshDatabase;
let migrator: Kysely<Database>;
let app: Kysely<Database>;
let admin: Kysely<Database>;

beforeAll(async () => {
  fresh = await freshDatabase();
  migrator = createDb(fresh.url);
  app = createDb(fresh.appUrl);
  admin = createDb(fresh.adminUrl);
  await migrateUp(migrator);
});
afterAll(async () => {
  await Promise.all([migrator?.destroy(), app?.destroy(), admin?.destroy()]);
  await fresh?.drop();
});

/** Every privilege vault_app holds on each table in public, table-level and column-level. */
async function appPrivileges(db: Kysely<Database>): Promise<Record<string, string[]>> {
  const { rows } = await sql<{ table_name: string; privilege: string }>`
    select table_name, privilege_type as privilege from information_schema.role_table_grants
      where grantee = 'vault_app' and table_schema = 'public'
    union
    select table_name, privilege_type || '(' || column_name || ')' from information_schema.column_privileges
      where grantee = 'vault_app' and table_schema = 'public'
        and not exists (select 1 from information_schema.role_table_grants t
          where t.grantee = 'vault_app' and t.table_schema = 'public' and t.table_name = column_privileges.table_name
            and t.privilege_type = column_privileges.privilege_type)
    order by 1, 2`.execute(db);
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.table_name] ??= []).push(r.privilege);
  return out;
}

const SIUD = ["DELETE", "INSERT", "SELECT", "UPDATE"];
/** M1.3 item (g): users are deactivated, not deleted (decision 8); only retention deletes them. */
const SIU = ["INSERT", "SELECT", "UPDATE"];
const AUDIT_INSERT_COLUMNS = ["action", "actor_user_id", "details", "entity_id", "entity_type", "ip_prefix"];

describe("the roles (init script)", () => {
  it("both roles can log in and hold no special attributes: not superuser, no createdb, createrole, replication or bypassrls", async () => {
    const { rows } = await sql<Record<string, unknown>>`
      select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      from pg_roles where rolname in ('vault_app', 'vault_migrator') order by rolname`.execute(admin);
    expect(rows).toEqual(
      ["vault_app", "vault_migrator"].map((rolname) => ({
        rolname,
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      })),
    );
  });

  it("neither role is a member of another role (no inherited rights)", async () => {
    const { rows } = await sql`
      select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.member
      where r.rolname in ('vault_app', 'vault_migrator')`.execute(admin);
    expect(rows).toEqual([]);
  });

  it("vault_migrator owns the database, the public schema (as database owner), every table and every function in public", async () => {
    const { rows } = await sql<{ kind: string; name: string; owner: string }>`
      select 'database' as kind, datname as name, pg_get_userbyid(datdba) as owner from pg_database where datname = current_database()
      union all
      select 'table', c.relname, pg_get_userbyid(c.relowner) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'S', 'v', 'm', 'p')
      union all
      select 'function', p.proname, pg_get_userbyid(p.proowner) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
      union all
      select 'schema', nspname, pg_get_userbyid(nspowner) from pg_namespace where nspname in ('public', 'pgboss')`.execute(admin);
    for (const row of rows) {
      const expected = row.kind === "schema" && row.name === "public" ? "pg_database_owner" : "vault_migrator";
      expect(row.owner, `${row.kind} ${row.name}`).toBe(expected);
    }
    expect(rows.filter((r) => r.kind === "table").map((r) => r.name)).toContain("audit_log");
  });

  it("vault_app owns nothing in the database", async () => {
    const { rows } = await sql`
      select c.relname as name from pg_class c where c.relowner = 'vault_app'::regrole
      union all select p.proname from pg_proc p where p.proowner = 'vault_app'::regrole
      union all select n.nspname from pg_namespace n where n.nspowner = 'vault_app'::regrole`.execute(admin);
    expect(rows).toEqual([]);
  });

  it("vault_app can't create anything in public, create a schema, or create a database", async () => {
    const attempt = async (text: string) =>
      sql.raw(text).execute(app).then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
    expect(await attempt("create table public.sneaky (id int)")).toBe("42501");
    expect(await attempt("create function public.sneaky() returns int language sql as 'select 1'")).toBe("42501");
    expect(await attempt("create view public.sneaky as select 1")).toBe("42501");
    expect(await attempt("create schema sneaky")).toBe("42501");
    expect(await attempt("create database sneaky")).toBe("42501");
  });
});

describe("what vault_app may do (migration 0004)", () => {
  it("business tables: SELECT, INSERT, UPDATE, DELETE only; audit_log: SELECT and INSERT on the app-settable columns only; the schema version: SELECT", async () => {
    expect(await appPrivileges(migrator)).toEqual({
      _meta: SIUD,
      audit_log: [...AUDIT_INSERT_COLUMNS.map((c) => `INSERT(${c})`), "SELECT"],
      kysely_migration: ["SELECT"],
      people: SIUD,
      users: SIU,
    });
  });

  it("every table in public has a deliberate grant decision (a new table without one fails here: grant it in its migration with grantAppAccess)", async () => {
    const decided = ["_meta", "audit_log", "kysely_migration", "kysely_migration_lock", "people", "users"];
    const { rows } = await sql<{ name: string }>`
      select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') order by 1`.execute(migrator);
    expect(rows.map((r) => r.name)).toEqual(decided);
  });

  it("audit_log_retention() is SECURITY DEFINER, owned by vault_migrator, with a fixed search_path; vault_app may execute it, PUBLIC may not", async () => {
    const { rows } = await sql<{ secdef: boolean; owner: string; config: string[] | null; app: boolean; public_execute: boolean }>`
      select p.prosecdef as secdef, pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
        has_function_privilege('vault_app', p.oid, 'execute') as app,
        exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute
      from pg_proc p where p.proname = 'audit_log_retention'`.execute(migrator);
    expect(rows).toEqual([{ secdef: true, owner: "vault_migrator", config: ["search_path=pg_catalog, pg_temp"], app: true, public_execute: false }]);
  });

  it("no other function in public is SECURITY DEFINER", async () => {
    const { rows } = await sql<{ proname: string }>`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef order by 1`.execute(migrator);
    expect(rows.map((r) => r.proname)).toEqual(["audit_log_retention"]);
  });

  it("the pg-boss schema exists, is owned by vault_migrator, and vault_app may use it and create its job tables there", async () => {
    const { rows } = await sql<{ owner: string; usage: boolean; create: boolean }>`
      select pg_get_userbyid(nspowner) as owner,
        has_schema_privilege('vault_app', 'pgboss', 'usage') as usage,
        has_schema_privilege('vault_app', 'pgboss', 'create') as create
      from pg_namespace where nspname = 'pgboss'`.execute(migrator);
    expect(rows).toEqual([{ owner: "vault_migrator", usage: true, create: true }]);
  });

  it("every app-side function works as vault_app: people repository, heartbeat, schema version, audit retention", async () => {
    const person = await migrator.insertInto("people").values({ display_name: "App admin" }).returning("id").executeTakeFirstOrThrow();
    const user = await migrator.insertInto("users").values({ role: "admin", person_id: person.id }).returning("id").executeTakeFirstOrThrow();
    const viewer: Viewer = { userId: user.id, role: "admin", personId: person.id };
    const people = peopleRepository(app, { log: () => {} });
    const p = await people.create(viewer, { displayName: "Made as vault_app" });
    await people.get(viewer, p.id);
    await people.list(viewer);
    await people.update(viewer, p.id, { relationship: "x", visibility: "private" });
    await people.remove(viewer, p.id);
    const actions = await migrator.selectFrom("audit_log").select("action").where("entity_id", "=", p.id).orderBy("id").execute();
    expect(actions.map((a) => a.action)).toEqual(["create", "view", "view", "update", "delete"]);

    await recordHeartbeat(app, new Date("2026-11-21T10:00:00.000Z"));
    await recordHeartbeat(app, new Date("2026-11-21T10:01:00.000Z"));
    expect(await readHeartbeat(app)).toEqual(new Date("2026-11-21T10:01:00.000Z"));
    expect(await readSchemaVersion(app)).toBe(Object.keys(migrations).at(-1));

    const leaver = await migrator.insertInto("users").values({ role: "member", deactivated_at: new Date() }).returning("id").executeTakeFirstOrThrow();
    await sql`insert into audit_log (actor_user_id, action, at) values (${leaver.id}, 'sign_out', now() - interval '3 years'),
      (null, 'sign_in', now() - interval '100 days')`.execute(migrator);
    await sql`update audit_log set ip_prefix = null where false`.execute(migrator); // no-op: keeps the next insert honest
    await sql`insert into audit_log (action, ip_prefix, at) values ('sign_in', '10.0.0.0/24', now() - interval '100 days')`.execute(migrator);
    expect(await runAuditRetention(app)).toEqual({ deleted: 1, ipPrefixesCleared: 1, usersDeleted: 1 });
  });

  it("the app connection always uses search_path = public, even if the role's own default is changed (no shadow tables)", async () => {
    const dbName = new URL(fresh.url).pathname.slice(1);
    await sql.raw(`alter role vault_app in database ${dbName} set search_path = pgboss, public`).execute(admin);
    const fresh2 = createDb(fresh.appUrl);
    try {
      const { rows } = await sql<{ search_path: string }>`show search_path`.execute(fresh2);
      expect(rows[0]?.search_path).toBe("public");
    } finally {
      await fresh2.destroy();
      await sql.raw(`alter role vault_app in database ${dbName} reset search_path`).execute(admin);
    }
  });
});

describe("users are deactivated, not deleted (M1.3 item g, decision 8)", () => {
  it("vault_app can't DELETE a user row, but retention (SECURITY DEFINER) still removes an expired deactivated user", async () => {
    const leaver = await migrator.insertInto("users").values({ role: "member", deactivated_at: new Date() }).returning("id").executeTakeFirstOrThrow();
    await expect(app.deleteFrom("users").where("id", "=", leaver.id).execute()).rejects.toMatchObject({ code: "42501" });
    await runAuditRetention(app);
    expect(await migrator.selectFrom("users").select("id").where("id", "=", leaver.id).executeTakeFirst()).toBeUndefined();
  });

  it("rolling back 0006 gives DELETE back; up takes it away again", async () => {
    const own = await freshDatabase();
    const m = createDb(own.url);
    try {
      await migrateTo(m, "0006_users_no_app_delete");
      expect((await appPrivileges(m)).users).toEqual(SIU);
      expect(await migrateDown(m)).toEqual(["0006_users_no_app_delete"]);
      expect((await appPrivileges(m)).users).toEqual(SIUD);
      await migrateTo(m, "0006_users_no_app_delete");
      expect((await appPrivileges(m)).users).toEqual(SIU);
    } finally {
      await m.destroy();
      await own.drop();
    }
  });
});

describe("migration 0004 down and up", () => {
  it("down revokes everything vault_app had and drops the pg-boss schema; up grants it all again", async () => {
    const own = await freshDatabase();
    const m = createDb(own.url);
    try {
      await migrateTo(m, "0004_database_roles");
      const granted = await appPrivileges(m);
      expect(await migrateDown(m)).toEqual(["0004_database_roles"]);
      expect(await appPrivileges(m)).toEqual({});
      const { rows } = await sql<{ execute: boolean; pgboss: string | null }>`
        select has_function_privilege('vault_app', 'audit_log_retention()', 'execute') as execute,
          to_regnamespace('pgboss')::text as pgboss`.execute(m);
      expect(rows).toEqual([{ execute: false, pgboss: null }]);
      const app2 = new pg.Client({ connectionString: own.appUrl });
      await app2.connect();
      await expect(app2.query("select 1 from people")).rejects.toMatchObject({ code: "42501" });
      await app2.end();
      await migrateTo(m, "0004_database_roles");
      expect(await appPrivileges(m)).toEqual(granted);
    } finally {
      await m.destroy();
      await own.drop();
    }
  });

  it("a malformed audit insert by vault_app still fails on the constraint, not on privileges (grants don't weaken checks)", async () => {
    await expect(sql`insert into audit_log (action, entity_type, entity_id) values ('view', 'person', ${randomUUID()}), ('view', null, null)`.execute(app)).rejects.toMatchObject({ code: "23514" });
  });
});
