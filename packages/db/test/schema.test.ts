import { randomUUID } from "node:crypto";
import { sql, type Kysely, type RawBuilder } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { migrateUp } from "../src/migrate.ts";
import type { Database } from "../src/schema.ts";
import { freshDatabase } from "./support/fresh-database.ts";

// M1.2 data model: constraints live in Postgres, not only in app code.
// SQLSTATEs: 23502 not null, 23503 foreign key, 23001 restrict (ON DELETE RESTRICT), 23505 unique,
// 23514 check, 42501 append-only guard.
const SYSTEM_TABLES = ["_meta", "audit_log", "users"];

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

const run = (query: RawBuilder<unknown>) => query.execute(db);
const fails = (query: RawBuilder<unknown>, code: string) => expect(run(query)).rejects.toMatchObject({ code });

async function newPerson(name = "Alex", owner: string | null = null): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    insert into people (display_name, owner_person_id) values (${name}, ${owner}) returning id`.execute(db);
  return rows[0]!.id;
}

async function newUser(personId: string | null = null, role = "member"): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    insert into users (person_id, role) values (${personId}, ${role}) returning id`.execute(db);
  return rows[0]!.id;
}

describe("every business table carries the shared record columns (AC1)", () => {
  async function businessTables(): Promise<string[]> {
    const { rows } = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not like 'kysely_%'
      order by table_name`.execute(db);
    return rows.map((r) => r.table_name).filter((t) => !SYSTEM_TABLES.includes(t));
  }

  it("people is a business table", async () => {
    expect(await businessTables()).toContain("people");
  });

  it("each one has id, owner, visibility, timestamps and created/updated-by, with the right types and defaults", async () => {
    for (const table of await businessTables()) {
      const { rows } = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>`
        select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = ${table}`.execute(db);
      const col = Object.fromEntries(rows.map((r) => [r.column_name, r]));
      expect(col.id, table).toMatchObject({ data_type: "uuid", is_nullable: "NO", column_default: "gen_random_uuid()" });
      expect(col.owner_person_id, table).toMatchObject({ data_type: "uuid", is_nullable: table === "people" ? "YES" : "NO" });
      expect(col.visibility, table).toMatchObject({ data_type: "text", is_nullable: "NO", column_default: "'family'::text" });
      for (const c of ["created_at", "updated_at"]) {
        expect(col[c], `${table}.${c}`).toMatchObject({ data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" });
      }
      for (const c of ["created_by_user_id", "updated_by_user_id"]) {
        expect(col[c], `${table}.${c}`).toMatchObject({ data_type: "uuid", is_nullable: "YES" });
      }
    }
  });

  it("each one has foreign keys to people (owner, delete restricted) and users, a visibility check and an updated_at trigger", async () => {
    for (const table of await businessTables()) {
      const { rows: fks } = await sql<{ col: string; ref: string; del: string }>`
        select a.attname as col, c.confrelid::regclass::text as ref, c.confdeltype as del
        from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and c.conrelid = ${table}::regclass`.execute(db);
      expect(fks, table).toEqual(
        expect.arrayContaining([
          { col: "owner_person_id", ref: "people", del: "r" },
          { col: "created_by_user_id", ref: "users", del: "n" },
          { col: "updated_by_user_id", ref: "users", del: "n" },
        ]),
      );
      const { rows: triggers } = await sql<{ tgname: string }>`
        select tgname from pg_trigger where tgrelid = ${table}::regclass and not tgisinternal`.execute(db);
      expect(triggers.map((t) => t.tgname), table).toContain(`${table}_set_updated_at`);
    }
  });
});

describe("bad inserts fail at the database (AC3)", () => {
  it("bad foreign key: an owner that does not exist", async () => {
    await fails(sql`insert into people (display_name, owner_person_id) values ('A', ${randomUUID()})`, "23503");
  });

  it("bad enum: visibility outside family/private, role outside admin/member, unknown audit action", async () => {
    await fails(sql`insert into people (display_name, visibility) values ('A', 'public')`, "23514");
    await fails(sql`insert into people (display_name, visibility) values ('A', 'restricted')`, "23514");
    await fails(sql`insert into users (role) values ('root')`, "23514");
    await fails(sql`insert into audit_log (action) values ('hack')`, "23514");
  });

  it("missing required values: name, visibility", async () => {
    await fails(sql`insert into people (relationship) values ('aunt')`, "23502");
    await fails(sql`insert into people (display_name, visibility) values ('A', null)`, "23502");
  });

  it("name length: 1 to 100 characters, not blank; relationship at most 50", async () => {
    await fails(sql`insert into people (display_name) values (${"x".repeat(101)})`, "23514");
    await fails(sql`insert into people (display_name) values ('')`, "23514");
    await fails(sql`insert into people (display_name) values ('   ')`, "23514");
    await fails(sql`insert into people (display_name, relationship) values ('A', ${"x".repeat(51)})`, "23514");
    await expect(newPerson("x".repeat(100))).resolves.toBeTypeOf("string");
    await expect(run(sql`insert into people (display_name, relationship) values ('A', ${"x".repeat(50)})`)).resolves.toBeDefined();
  });

  it("users: a person links to at most one user, and only to a person that exists", async () => {
    const person = await newPerson();
    await newUser(person);
    await fails(sql`insert into users (person_id) values (${person})`, "23505");
    await fails(sql`insert into users (person_id) values (${randomUUID()})`, "23503");
  });

  it("users default to the member role", async () => {
    const id = await newUser();
    const { rows } = await sql<{ role: string }>`select role from users where id = ${id}`.execute(db);
    expect(rows[0]?.role).toBe("member");
  });

  it("people default to family visibility", async () => {
    const id = await newPerson();
    const { rows } = await sql<{ visibility: string }>`select visibility from people where id = ${id}`.execute(db);
    expect(rows[0]?.visibility).toBe("family");
  });
});

describe("people and users integrity", () => {
  it("updated_at moves on update; created_at does not", async () => {
    const id = await newPerson();
    await run(sql`update people set created_at = now() - interval '1 day', updated_at = now() - interval '1 day' where id = ${id}`);
    await run(sql`update people set display_name = 'Renamed' where id = ${id}`);
    const { rows } = await sql<{ fresh: boolean; old: boolean }>`
      select updated_at > now() - interval '1 minute' as fresh, created_at < now() - interval '1 hour' as old
      from people where id = ${id}`.execute(db);
    expect(rows[0]).toEqual({ fresh: true, old: true });
  });

  it("a person who owns records cannot be deleted (FK restrict); after reassigning, they can", async () => {
    const owner = await newPerson("Owner");
    const owned = await newPerson("Child", owner);
    await fails(sql`delete from people where id = ${owner}`, "23001");
    await run(sql`update people set owner_person_id = null where id = ${owned}`);
    await expect(run(sql`delete from people where id = ${owner}`)).resolves.toBeDefined();
  });

  it("a person who owns only their own record can be deleted", async () => {
    const self = await newPerson("Self");
    await run(sql`update people set owner_person_id = ${self} where id = ${self}`);
    await expect(run(sql`delete from people where id = ${self}`)).resolves.toBeDefined();
  });

  it("a person linked to a user cannot be deleted until the link is removed", async () => {
    const person = await newPerson();
    await newUser(person);
    await fails(sql`delete from people where id = ${person}`, "23001");
  });
});

describe("audit_log", () => {
  async function audit(values: { action: string; at?: string; ip?: string | null; details?: unknown; entity?: boolean }) {
    const entityType = values.entity === false ? null : "person";
    const entityId = values.entity === false ? null : randomUUID();
    const { rows } = await sql<{ id: string }>`
      insert into audit_log (action, at, entity_type, entity_id, ip_prefix, details)
      values (${values.action}, coalesce(${values.at ?? null}::timestamptz, now()), ${entityType}, ${entityId},
              ${values.ip ?? null}, ${values.details === undefined ? null : JSON.stringify(values.details)}::jsonb)
      returning id`.execute(db);
    return rows[0]!.id;
  }

  it("accepts every action in the design note", async () => {
    for (const action of ["view", "create", "update", "delete"]) await audit({ action });
    for (const action of ["sign_in", "sign_in_failed", "sign_out", "2fa_enrolled", "2fa_failed", "password_changed", "backup_code_used"]) {
      await audit({ action, entity: false });
    }
  });

  it("is append-only: UPDATE, DELETE and TRUNCATE fail (AC4)", async () => {
    const id = await audit({ action: "view" });
    await fails(sql`update audit_log set action = 'create' where id = ${id}`, "42501");
    await fails(sql`delete from audit_log where id = ${id}`, "42501");
    await fails(sql`truncate audit_log`, "42501");
  });

  it("an actor must be a real user", async () => {
    await fails(sql`insert into audit_log (action, actor_user_id) values ('sign_out', ${randomUUID()})`, "23503");
  });

  it("view/create/update/delete name their entity; entity type and id come together", async () => {
    await fails(sql`insert into audit_log (action) values ('view')`, "23514");
    await fails(sql`insert into audit_log (action, entity_type) values ('sign_in', 'person')`, "23514");
    await fails(sql`insert into audit_log (action, entity_id) values ('sign_in', ${randomUUID()})`, "23514");
  });

  it("details hold changed field names only, never values", async () => {
    await audit({ action: "update", details: { fields: ["display_name", "relationship"] } });
    await audit({ action: "update", details: { fields: [] } });
    for (const details of [
      { display_name: "Alice" },
      { fields: ["display_name"], values: ["Alice"] },
      { fields: ["Alice Smith"] },
      { fields: [42] },
      { fields: [{ display_name: "Alice" }] },
      { fields: "display_name" },
      ["display_name"],
      "display_name",
    ]) {
      await expect(audit({ action: "update", details }), JSON.stringify(details)).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("ip_prefix is a /24 or /48 prefix, and only on sign-in events", async () => {
    await audit({ action: "sign_in", entity: false, ip: "192.168.1.0/24" });
    await audit({ action: "sign_in_failed", entity: false, ip: "2001:db8:1::/48" });
    await expect(audit({ action: "view", ip: "192.168.1.0/24" })).rejects.toMatchObject({ code: "23514" });
    await expect(audit({ action: "sign_out", entity: false, ip: "192.168.1.0/24" })).rejects.toMatchObject({ code: "23514" });
    await expect(audit({ action: "sign_in", entity: false, ip: "192.168.1.17/32" })).rejects.toMatchObject({ code: "23514" });
    await expect(audit({ action: "sign_in", entity: false, ip: "2001:db8:1:2::/64" })).rejects.toMatchObject({ code: "23514" });
    await expect(audit({ action: "sign_in", entity: false, ip: "192.168.1.17" })).rejects.toMatchObject({ code: "23514" });
  });

  describe("retention (AC4)", () => {
    it("deletes rows older than 2 years and nulls ip_prefix after 90 days, nothing else", async () => {
      const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
      // Backdated through the only path tests have: an insert with an explicit time.
      const expired = await audit({ action: "view", at: daysAgo(731) });
      const oldIp = await audit({ action: "sign_in", entity: false, ip: "10.0.3.0/24", at: daysAgo(91) });
      const recent = await audit({ action: "sign_in", entity: false, ip: "10.0.2.0/24", at: daysAgo(89) });
      const keptOld = await audit({ action: "view", at: daysAgo(729) });

      const { rows } = await sql<{ deleted: string; ip_prefixes_cleared: string }>`select * from audit_log_retention()`.execute(db);
      expect(Number(rows[0]?.deleted)).toBeGreaterThanOrEqual(1);
      expect(Number(rows[0]?.ip_prefixes_cleared)).toBeGreaterThanOrEqual(1);

      const left = await sql<{ id: string; ip_prefix: string | null }>`select id, ip_prefix from audit_log where id in (${expired}, ${oldIp}, ${recent}, ${keptOld})`.execute(db);
      const byId = Object.fromEntries(left.rows.map((r) => [r.id, r.ip_prefix]));
      expect(byId).not.toHaveProperty(expired);
      expect(byId[oldIp]).toBeNull();
      expect(byId[recent]).toBe("10.0.2.0/24");
      expect(byId).toHaveProperty(keptOld);
    });

    it("a second run changes nothing", async () => {
      const { rows } = await sql<{ deleted: string; ip_prefixes_cleared: string; users_deleted: string }>`select * from audit_log_retention()`.execute(db);
      expect(rows[0]).toEqual({ deleted: "0", ip_prefixes_cleared: "0", users_deleted: "0" });
    });

    it("outside the retention function, even an expired row can't be deleted or an old ip_prefix cleared", async () => {
      const expired = await audit({ action: "view", at: new Date(Date.now() - 800 * 86_400_000).toISOString() });
      const oldIp = await audit({ action: "sign_in", entity: false, ip: "10.0.4.0/24", at: new Date(Date.now() - 100 * 86_400_000).toISOString() });
      await fails(sql`delete from audit_log where id = ${expired}`, "42501");
      await fails(sql`update audit_log set ip_prefix = null where id = ${oldIp}`, "42501");
    });

    it("setting the retention flag by hand still can't delete a recent row or change anything but an old ip_prefix", async () => {
      const recent = await audit({ action: "view" });
      const oldIp = await audit({ action: "sign_in", entity: false, ip: "10.0.5.0/24", at: new Date(Date.now() - 100 * 86_400_000).toISOString() });
      await db.connection().execute(async (conn) => {
        await sql`select set_config('vault.audit_retention', 'on', false)`.execute(conn);
        try {
          await expect(sql`delete from audit_log where id = ${recent}`.execute(conn)).rejects.toMatchObject({ code: "42501" });
          await expect(sql`update audit_log set ip_prefix = null where id = ${recent}`.execute(conn)).rejects.toMatchObject({ code: "42501" });
          await expect(sql`update audit_log set action = 'sign_out' where id = ${oldIp}`.execute(conn)).rejects.toMatchObject({ code: "42501" });
          await expect(sql`update audit_log set ip_prefix = '10.9.9.0/24' where id = ${oldIp}`.execute(conn)).rejects.toMatchObject({ code: "42501" });
        } finally {
          await sql`select set_config('vault.audit_retention', 'off', false)`.execute(conn);
        }
      });
    });
  });
});
