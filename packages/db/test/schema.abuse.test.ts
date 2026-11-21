import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { migrateDown, migrateUp } from "../src/migrate.ts";
import { readSchemaVersion } from "../src/schema-version.ts";
import type { Database } from "../src/schema.ts";
import { migrateTo } from "./support/migrate.ts";
import { freshDatabase } from "./support/fresh-database.ts";

// Tester (M1.2 AC1 + AC3): bad inserts and bad updates fail at the database, however they arrive
// (raw SQL stands in for a bug or an injection in app code). SQLSTATEs: 23502 not null,
// 23503 FK, 23505 unique, 23514 check, 22P02 bad uuid text, 23001 restrict.
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

const code = async (q: ReturnType<typeof sql>) => (await q.execute(db).then(() => "ok", (e: { code?: string }) => e.code ?? "error")) as string;
const newPerson = async (name = "P") => (await sql<{ id: string }>`insert into people (display_name) values (${name}) returning id`.execute(db)).rows[0]!.id;

describe("people: bad inserts and updates", () => {
  it("explicit NULL for a NOT NULL column (display_name, visibility, created_at, updated_at, id) is refused, not defaulted", async () => {
    expect(await code(sql`insert into people (display_name) values (null)`)).toBe("23502");
    expect(await code(sql`insert into people (display_name, visibility) values ('x', null)`)).toBe("23502");
    expect(await code(sql`insert into people (display_name, created_at) values ('x', null)`)).toBe("23502");
    expect(await code(sql`insert into people (display_name, updated_at) values ('x', null)`)).toBe("23502");
    expect(await code(sql`insert into people (id, display_name) values (null, 'x')`)).toBe("23502");
  });

  it("a duplicate primary key, a malformed uuid and a malformed owner uuid are refused", async () => {
    const id = await newPerson();
    expect(await code(sql`insert into people (id, display_name) values (${id}, 'dup')`)).toBe("23505");
    expect(await code(sql`insert into people (id, display_name) values ('not-a-uuid', 'x')`)).toBe("22P02");
    expect(await code(sql`insert into people (display_name, owner_person_id) values ('x', 'not-a-uuid')`)).toBe("22P02");
  });

  it("an update cannot point the owner at a person that does not exist, nor set visibility outside the enum, nor blank the name", async () => {
    const id = await newPerson();
    expect(await code(sql`update people set owner_person_id = ${randomUUID()} where id = ${id}`)).toBe("23503");
    expect(await code(sql`update people set visibility = 'restricted' where id = ${id}`)).toBe("23514");
    expect(await code(sql`update people set visibility = null where id = ${id}`)).toBe("23502");
    expect(await code(sql`update people set display_name = '' where id = ${id}`)).toBe("23514");
    expect(await code(sql`update people set display_name = repeat('x', 101) where id = ${id}`)).toBe("23514");
    expect(await code(sql`update people set relationship = repeat('x', 51) where id = ${id}`)).toBe("23514");
  });

  it("created_by / updated_by must be real users", async () => {
    expect(await code(sql`insert into people (display_name, created_by_user_id) values ('x', ${randomUUID()})`)).toBe("23503");
    expect(await code(sql`insert into people (display_name, updated_by_user_id) values ('x', ${randomUUID()})`)).toBe("23503");
  });

  it("updated_at cannot be forged by the writer: the trigger always sets it to now(), even when an UPDATE names a past or future value", async () => {
    const id = await newPerson();
    for (const forged of ["2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]) {
      const { rows } = await sql<{ forged: boolean }>`
        update people set display_name = ${`n${forged}`}, updated_at = ${forged}::timestamptz where id = ${id}
        returning (updated_at = ${forged}::timestamptz) as forged`.execute(db);
      expect(rows[0]!.forged).toBe(false);
    }
  });

  it("updated_at moves on an UPDATE of any single column, including visibility and owner", async () => {
    const id = await newPerson();
    const owner = await newPerson("Owner");
    const read = async () => (await sql<{ t: string }>`select updated_at::text as t from people where id = ${id}`.execute(db)).rows[0]!.t;
    let last = await read();
    for (const change of [sql`visibility = 'private'`, sql`owner_person_id = ${owner}`, sql`relationship = 'x'`]) {
      await sql`select pg_sleep(0.01)`.execute(db);
      await sql`update people set ${change} where id = ${id}`.execute(db);
      const now = await read();
      expect(now > last, String(change)).toBe(true);
      last = now;
    }
  });

  it("a one-statement multi-row insert with one bad row inserts none", async () => {
    const before = Number((await sql<{ n: string }>`select count(*) as n from people`.execute(db)).rows[0]!.n);
    expect(await code(sql`insert into people (display_name) values ('good one'), ('good two'), (${"x".repeat(101)})`)).toBe("23514");
    expect(Number((await sql<{ n: string }>`select count(*) as n from people`.execute(db)).rows[0]!.n)).toBe(before);
  });
});

describe("users: bad inserts and updates", () => {
  it("role must be exactly 'admin' or 'member' (case and whitespace matter, NULL refused)", async () => {
    for (const role of ["Admin", "ADMIN", "admin ", " member", "viewer", "owner", ""]) {
      expect(await code(sql`insert into users (role) values (${role})`), JSON.stringify(role)).toBe("23514");
    }
    expect(await code(sql`insert into users (role) values (null)`)).toBe("23502");
  });

  it("person_id is unique, must exist, and cannot be set to a malformed value", async () => {
    const p = await newPerson();
    await sql`insert into users (person_id) values (${p})`.execute(db);
    expect(await code(sql`insert into users (person_id) values (${p})`)).toBe("23505");
    expect(await code(sql`insert into users (person_id) values (${randomUUID()})`)).toBe("23503");
    expect(await code(sql`insert into users (person_id) values ('x')`)).toBe("22P02");
  });

  it("any number of users may have no linked person (NULLs do not collide in the unique index)", async () => {
    await sql`insert into users (person_id) values (null), (null), (null)`.execute(db);
  });

  it("promoting a member to admin or relinking a person is a plain UPDATE the database allows (authorisation for that belongs to M1.3), and updated_at moves", async () => {
    const { rows } = await sql<{ id: string }>`insert into users default values returning id`.execute(db);
    const before = (await sql<{ t: string }>`select updated_at::text as t from users where id = ${rows[0]!.id}`.execute(db)).rows[0]!.t;
    await sql`select pg_sleep(0.01)`.execute(db);
    await sql`update users set role = 'admin' where id = ${rows[0]!.id}`.execute(db);
    const after = (await sql<{ t: string; role: string }>`select updated_at::text as t, role from users where id = ${rows[0]!.id}`.execute(db)).rows[0]!;
    expect(after.role).toBe("admin");
    expect(after.t > before).toBe(true);
  });

  it("deleting a person who is linked to a login is refused (23001) and the link survives", async () => {
    const p = await newPerson("Linked");
    const u = (await sql<{ id: string }>`insert into users (person_id) values (${p}) returning id`.execute(db)).rows[0]!.id;
    expect(await code(sql`delete from people where id = ${p}`)).toBe("23001");
    expect((await sql<{ person_id: string }>`select person_id from users where id = ${u}`.execute(db)).rows[0]!.person_id).toBe(p);
  });
});

describe("migration 0002 rollback and re-apply", () => {
  it("rolling back 0002 drops people, users and set_updated_at; re-applying gives an empty, working schema; the schema version follows", async () => {
    const fresh = await freshDatabase();
    const own = createDb(fresh.url);
    try {
      await migrateTo(own, "0004_database_roles");
      await sql`insert into people (display_name) values ('Gone')`.execute(own);
      await migrateDown(own); // 0004
      await migrateDown(own); // 0003
      expect(await migrateDown(own)).toEqual(["0002_people_users"]);
      expect(await readSchemaVersion(own)).toBe("0001_meta");
      const left = await sql<{ n: string }>`
        select count(*) as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('people', 'users', 'audit_log')`.execute(own);
      expect(Number(left.rows[0]!.n)).toBe(0);
      const fn = await sql<{ n: string }>`select count(*) as n from pg_proc where proname in ('set_updated_at', 'audit_log_guard', 'audit_log_retention')`.execute(own);
      expect(Number(fn.rows[0]!.n)).toBe(0);
      await migrateUp(own);
      expect((await sql<{ n: string }>`select count(*) as n from people`.execute(own)).rows[0]!.n).toBe("0");
    } finally {
      await own.destroy();
      await fresh.drop();
    }
  });

  it("rolling back 0002 while a person row is still referenced by another record in the same database succeeds (one DROP, no dangling FK), and nothing in 0001 (_meta) is touched", async () => {
    const fresh = await freshDatabase();
    const own = createDb(fresh.url);
    try {
      await migrateTo(own, "0004_database_roles");
      const owner = (await sql<{ id: string }>`insert into people (display_name) values ('Owner') returning id`.execute(own)).rows[0]!.id;
      await sql`insert into people (display_name, owner_person_id) values ('Child', ${owner})`.execute(own);
      await sql`insert into users (person_id) values (${owner})`.execute(own);
      await sql`insert into _meta (key, value) values ('keep', 'me')`.execute(own);
      await migrateDown(own); // 0004
      await migrateDown(own); // 0003
      await expect(migrateDown(own)).resolves.toEqual(["0002_people_users"]);
      expect((await sql<{ value: string }>`select value from _meta where key = 'keep'`.execute(own)).rows[0]!.value).toBe("me");
    } finally {
      await own.destroy();
      await fresh.drop();
    }
  });
});
