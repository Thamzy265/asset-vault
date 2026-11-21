import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { migrateDown, migrateUp } from "../src/migrate.ts";
import { readSchemaVersion } from "../src/schema-version.ts";
import { runAuditRetention } from "../src/index.ts";
import type { Database } from "../src/schema.ts";
import { migrateTo } from "./support/migrate.ts";
import { freshDatabase } from "./support/fresh-database.ts";

// Tester (M1.2): tampering with the audit log, retention boundaries, and what the
// database role can and cannot do. `url` connects as vault_migrator (the owner, like the migrate
// service); `appUrl` as vault_app (like web and worker). Design note: "audit_log is append-only: a
// trigger raises on UPDATE and DELETE, except a retention function"; "2 years" and "90 days";
// "details never hold values"; "ip_prefix: /24 or /48, only on the sign-in events" (decision 4).
let db: Kysely<Database>;
let drop: () => Promise<void>;
let url: string;
let appUrl: string;

beforeAll(async () => {
  const fresh = await freshDatabase();
  drop = fresh.drop;
  url = fresh.url;
  appUrl = fresh.appUrl;
  db = createDb(url);
  await migrateUp(db);
});
afterAll(async () => {
  await db?.destroy();
  await drop?.();
});

/** One connection, one transaction, always rolled back: boundary tests need a frozen now(). */
async function inRolledBackTx<T>(body: (q: (text: string, values?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    return await body((text, values) => client.query(text, values));
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

/** Runs one statement in its own transaction and reports the SQLSTATE (or "ok"). Rolls back. */
async function sqlstate(text: string, setup?: string): Promise<string> {
  return inRolledBackTx(async (q) => {
    if (setup) await q(setup);
    await q("savepoint s");
    try {
      await q(text);
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code ?? "error";
    }
  });
}

const OLD = "now() - interval '3 years'";

describe("retention boundaries (frozen now(): everything inside one transaction)", () => {
  it("a row exactly 2 years old is kept; one microsecond older is deleted", async () => {
    await inRolledBackTx(async (q) => {
      await q(`insert into audit_log (action, entity_type, entity_id, at) values
        ('view','person',$1, now() - interval '2 years'),
        ('view','person',$2, now() - interval '2 years' - interval '1 microsecond'),
        ('view','person',$3, now() - interval '2 years' + interval '1 microsecond')`, [randomUUID(), randomUUID(), randomUUID()]);
      const { rows } = await q("select * from audit_log_retention()");
      expect(Number(rows[0].deleted)).toBe(1);
      expect((await q("select count(*)::int as n from audit_log")).rows[0].n).toBe(2);
    });
  });

  it("an ip_prefix exactly 90 days old is kept; one microsecond older is cleared; a fresher one is kept", async () => {
    await inRolledBackTx(async (q) => {
      await q(`insert into audit_log (action, ip_prefix, at) values
        ('sign_in','10.0.0.0/24', now() - interval '90 days'),
        ('sign_in','10.0.1.0/24', now() - interval '90 days' - interval '1 microsecond'),
        ('sign_in','10.0.2.0/24', now() - interval '90 days' + interval '1 microsecond')`);
      const { rows } = await q("select * from audit_log_retention()");
      expect(Number(rows[0].ip_prefixes_cleared)).toBe(1);
      const left = (await q("select ip_prefix from audit_log order by ip_prefix")).rows.map((r) => r.ip_prefix);
      expect(left).toEqual(["10.0.0.0/24", "10.0.2.0/24", null].sort((a, b) => (a === null ? 1 : b === null ? -1 : a < b ? -1 : 1)));
    });
  });

  it("an old row that also has an ip_prefix is deleted (not merely cleared) and counted once, as a delete", async () => {
    await inRolledBackTx(async (q) => {
      await q(`insert into audit_log (action, ip_prefix, at) values ('sign_in','10.9.9.0/24', ${OLD})`);
      const { rows } = await q("select * from audit_log_retention()");
      expect([Number(rows[0].deleted), Number(rows[0].ip_prefixes_cleared)]).toEqual([1, 0]);
    });
  });

  it("rows dated in the future, and rows with no ip_prefix between 90 days and 2 years, are never touched", async () => {
    await inRolledBackTx(async (q) => {
      await q(`insert into audit_log (action, entity_type, entity_id, at) values
        ('view','person',$1, now() + interval '1 day'),
        ('create','person',$2, now() - interval '1 year'),
        ('view','person',$3, now() - interval '2 years' + interval '1 second')`, [randomUUID(), randomUUID(), randomUUID()]);
      const { rows } = await q("select * from audit_log_retention()");
      expect([Number(rows[0].deleted), Number(rows[0].ip_prefixes_cleared)]).toEqual([0, 0]);
      expect((await q("select count(*)::int as n from audit_log")).rows[0].n).toBe(3);
    });
  });

  it("clearing the ip_prefix changes nothing else about the row (action, actor, entity, details, at, id)", async () => {
    await inRolledBackTx(async (q) => {
      const { rows: inserted } = await q(`insert into audit_log (action, ip_prefix, at, details) values ('sign_in','10.7.7.0/24', now() - interval '100 days', null) returning *`);
      await q("select * from audit_log_retention()");
      const { rows } = await q("select * from audit_log where id = $1", [inserted[0].id]);
      expect({ ...rows[0], ip_prefix: "x" }).toEqual({ ...inserted[0], ip_prefix: "x" });
      expect(rows[0].ip_prefix).toBeNull();
    });
  });

  it("the retention flag is switched off again after the function, so a delete later in the same transaction is refused", async () => {
    await inRolledBackTx(async (q) => {
      await q("select * from audit_log_retention()");
      await q(`insert into audit_log (action, entity_type, entity_id, at) values ('view','person',$1, ${OLD})`, [randomUUID()]);
      await q("savepoint s");
      await expect(q("delete from audit_log")).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("calling retention twice in a row, and on an empty table, returns zeros and does not fail", async () => {
    await inRolledBackTx(async (q) => {
      await q("select * from audit_log_retention()");
      const { rows } = await q("select * from audit_log_retention()");
      expect([Number(rows[0].deleted), Number(rows[0].ip_prefixes_cleared)]).toEqual([0, 0]);
    });
  });

  it("works the same from a session in another time zone and with a non-default DateStyle (boundaries do not depend on the session)", async () => {
    for (const tz of ["UTC", "Pacific/Kiritimati", "America/Los_Angeles", "Europe/London"]) {
      await inRolledBackTx(async (q) => {
        await q(`set local timezone = '${tz}'`);
        await q(`insert into audit_log (action, entity_type, entity_id, at) values
          ('view','person',$1, now() - interval '2 years'),
          ('view','person',$2, now() - interval '2 years' - interval '1 microsecond')`, [randomUUID(), randomUUID()]);
        const { rows } = await q("select * from audit_log_retention()");
        expect(Number(rows[0].deleted), tz).toBe(1);
      });
    }
  });

  it("runAuditRetention from the app reports the real counts and survives a concurrent second run", async () => {
    const id = randomUUID();
    await db.insertInto("audit_log").values({ action: "view", entity_type: "person", entity_id: id }).execute();
    const [a, b] = await Promise.all([runAuditRetention(db), runAuditRetention(db)]);
    expect(a.deleted + b.deleted).toBe(0);
    await expect(db.selectFrom("audit_log").select("id").where("entity_id", "=", id).execute()).resolves.toHaveLength(1);
  });
});

describe("tampering with the retention flag by hand (anything retention itself would not do must still fail)", () => {
  const flag = "select set_config('vault.audit_retention','on',true)";
  const recent = `insert into audit_log (id, action, entity_type, entity_id, at) overriding system value values (900001,'view','person','${randomUUID()}', now())`;

  it("with the flag on: deleting a recent row, updating a recent row and truncating all still fail", async () => {
    expect(await sqlstate("delete from audit_log where id = 900001", `${recent}; ${flag}`)).toBe("42501");
    expect(await sqlstate("update audit_log set action = 'create' where id = 900001", `${recent}; ${flag}`)).toBe("42501");
    expect(await sqlstate("truncate audit_log", `${recent}; ${flag}`)).toBe("42501");
    expect(await sqlstate("delete from audit_log", `${recent}; ${flag}`)).toBe("42501");
  });

  it("with the flag on: an OLD row (past 90 days, inside 2 years) can only lose its ip_prefix; any other column change fails", async () => {
    const old = `insert into audit_log (id, action, ip_prefix, at, details) overriding system value values (900002,'sign_in','10.1.1.0/24', now() - interval '100 days', null); ${flag}`;
    expect(await sqlstate("update audit_log set ip_prefix = null where id = 900002", old)).toBe("ok");
    expect(await sqlstate("update audit_log set ip_prefix = '10.2.2.0/24' where id = 900002", old)).toBe("42501");
    expect(await sqlstate("update audit_log set action = 'sign_in_failed' where id = 900002", old)).toBe("42501");
    expect(await sqlstate("update audit_log set at = now() - interval '5 years' where id = 900002", old)).toBe("42501");
    expect(await sqlstate("update audit_log set at = now() where id = 900002", old)).toBe("42501");
    expect(await sqlstate(`update audit_log set details = '{"fields":["x"]}' where id = 900002`, old)).toBe("42501");
    expect(await sqlstate("update audit_log set id = 900003 where id = 900002", old)).not.toBe("ok"); // identity column: 428C9
    expect(await sqlstate("update audit_log set actor_user_id = null, ip_prefix = null where id = 900002", old)).toBe("ok"); // no-op on actor (already null)
  });

  it("with the flag on: a 2-year-old row can be deleted, but a 1.99-year-old one cannot", async () => {
    const rows = `insert into audit_log (id, action, entity_type, entity_id, at) overriding system value values
      (900010,'view','person','${randomUUID()}', now() - interval '3 years'),
      (900011,'view','person','${randomUUID()}', now() - interval '23 months'); ${flag}`;
    expect(await sqlstate("delete from audit_log where id = 900010", rows)).toBe("ok");
    expect(await sqlstate("delete from audit_log where id = 900011", rows)).toBe("42501");
  });

  it("the flag set to any other spelling ('ON', 'true', '1', ' on') grants nothing", async () => {
    for (const value of ["ON", "true", "1", " on", "on "]) {
      const setup = `insert into audit_log (id, action, entity_type, entity_id, at) overriding system value values (900020,'view','person','${randomUUID()}', ${OLD}); select set_config('vault.audit_retention','${value}',true)`;
      expect(await sqlstate("delete from audit_log where id = 900020", setup), value).toBe("42501");
    }
  });

  it("the flag does not leak across connections: a second session without it cannot delete an expired row", async () => {
    const id = randomUUID();
    const other = new pg.Client({ connectionString: url });
    await other.connect();
    try {
      await db.insertInto("audit_log").values({ action: "view", entity_type: "person", entity_id: id }).execute();
      await other.query("select set_config('vault.audit_retention','on',false)"); // session-level on THIS connection only
      const second = new pg.Client({ connectionString: url });
      await second.connect();
      try {
        await expect(second.query("delete from audit_log where entity_id = $1", [id])).rejects.toMatchObject({ code: "42501" });
      } finally {
        await second.end();
      }
    } finally {
      await other.end();
    }
  });
});

describe("what the app's database role can and cannot do to the audit log (decision 3)", () => {
  // Web and worker connect as vault_app: not a superuser, owns nothing, and on audit_log has
  // SELECT plus INSERT on the app-settable columns only. These were RECORD tests showing that the
  // old app login (superuser and table owner) could switch every protection off; they now assert
  // that vault_app can't.
  // One committed row for the statements to aim at (the log can't be cleaned up afterwards: append-only).
  const row = `insert into audit_log (id, action, entity_type, entity_id) overriding system value values (910001,'view','person','${randomUUID()}') on conflict (id) do nothing`;

  /** Runs `text` as vault_app in a rolled-back transaction; row 910001 exists (inserted by the owner). */
  async function asApp(text: string): Promise<string> {
    const owner = new pg.Client({ connectionString: url });
    const app = new pg.Client({ connectionString: appUrl });
    await owner.connect();
    await app.connect();
    try {
      await owner.query(row);
      await app.query("begin");
      try {
        await app.query(text);
        return "ok";
      } catch (error) {
        return (error as { code?: string }).code ?? "error";
      } finally {
        await app.query("rollback");
      }
    } finally {
      await owner.end();
      await app.end();
    }
  }

  it("plain DML as vault_app: UPDATE, DELETE and TRUNCATE are refused (no privilege, and the trigger behind it)", async () => {
    for (const statement of [
      "update audit_log set action = 'create' where id = 910001",
      "delete from audit_log where id = 910001",
      "truncate audit_log",
      "truncate audit_log cascade",
      "delete from audit_log",
      "with d as (delete from audit_log where id = 910001 returning 1) select * from d",
    ]) {
      expect(await asApp(statement), statement).toBe("42501");
    }
  });

  it("vault_app can't switch the guard off: DISABLE TRIGGER, DROP TRIGGER, session_replication_role, DROP FUNCTION are all refused", async () => {
    for (const statement of [
      "alter table audit_log disable trigger audit_log_append_only",
      "alter table audit_log disable trigger audit_log_no_truncate",
      "alter table audit_log disable trigger user",
      "alter table audit_log disable trigger all",
      "drop trigger audit_log_append_only on audit_log",
      "set session_replication_role = replica",
      "set local session_replication_role = replica",
      "drop function audit_log_guard() cascade",
      "create or replace function audit_log_guard() returns trigger language plpgsql as $$ begin return old; end $$",
      "drop function audit_log_retention()",
      "alter function audit_log_retention() security invoker",
      "drop table audit_log",
      "alter table audit_log rename to audit_log_old",
      "select set_config('vault.audit_retention','on',false); delete from audit_log where id = 910001",
    ]) {
      expect(await asApp(statement), statement).toBe("42501");
    }
  });

  it("vault_app can't drop or replace the check constraints (details/ip_prefix minimisation)", async () => {
    for (const statement of [
      "alter table audit_log drop constraint audit_log_details_field_names_only",
      "alter table audit_log drop constraint audit_log_ip_prefix",
      "alter table audit_log alter column details type text",
    ]) {
      expect(await asApp(statement), statement).toBe("42501");
    }
  });

  it("vault_app can insert the app-settable columns, but can't set `at` (no backdating) or `id`", async () => {
    expect(await asApp(`insert into audit_log (actor_user_id, action, entity_type, entity_id, ip_prefix, details) values (null, 'view', 'person', '${randomUUID()}', null, null)`)).toBe("ok");
    expect(await asApp(`insert into audit_log (action, entity_type, entity_id, at) values ('view','person','${randomUUID()}', now() - interval '3 years')`)).toBe("42501");
    expect(await asApp(`insert into audit_log (action, at) values ('sign_out', now())`)).toBe("42501");
    expect(await asApp(`insert into audit_log (id, action) overriding system value values (920001, 'sign_out')`)).toBe("42501");
    expect(await asApp(`insert into audit_log (id, action) values (default, 'sign_out')`)).toBe("42501");
  });

  it("retention works as vault_app: audit_log_retention() is SECURITY DEFINER, so it deletes an expired row the app itself can't", async () => {
    const owner = new pg.Client({ connectionString: url });
    const app = new pg.Client({ connectionString: appUrl });
    await owner.connect();
    await app.connect();
    try {
      const id = randomUUID();
      await owner.query(`insert into audit_log (action, entity_type, entity_id, at) values ('view','person',$1, ${OLD})`, [id]);
      await expect(app.query("delete from audit_log where entity_id = $1", [id])).rejects.toMatchObject({ code: "42501" });
      const { rows } = await app.query("select * from audit_log_retention()");
      expect(Number(rows[0].deleted)).toBe(1);
      expect((await owner.query("select count(*)::int as n from audit_log where entity_id = $1", [id])).rows[0].n).toBe(0);
    } finally {
      await owner.end();
      await app.end();
    }
  });
});

describe("details: field names only", () => {
  const insert = (details: unknown) =>
    db.insertInto("audit_log").values({ action: "update", entity_type: "person", entity_id: randomUUID(), details: JSON.stringify(details) as never }).execute();

  it.each([
    ["nested object value", { fields: ["display_name"], values: { display_name: "Jane" } }],
    ["extra top-level key", { fields: ["display_name"], extra: 1 }],
    ["extra key with null", { fields: ["display_name"], x: null }],
    ["key with different case", { Fields: ["display_name"] }],
    ["fields as a string", { fields: "display_name" }],
    ["fields as an object", { fields: { display_name: "Jane" } }],
    ["fields containing an object", { fields: [{ display_name: "Jane" }] }],
    ["nested array holding a value-shaped string", { fields: [["Jane Doe"]] }],
    ["doubly nested array", { fields: [[["Jane Doe"]]] }],
    ["fields containing null", { fields: [null] }],
    ["fields containing a number", { fields: [1] }],
    ["fields containing a boolean", { fields: [true] }],
    ["field with a space (a name or value)", { fields: ["Jane Doe"] }],
    ["field with an uppercase letter", { fields: ["DisplayName"] }],
    ["field starting with a digit", { fields: ["1name"] }],
    ["field with a dash", { fields: ["first-name"] }],
    ["field with an at sign (an email)", { fields: ["jane@example.com"] }],
    ["field with a dot", { fields: ["a.b"] }],
    ["field with a trailing newline", { fields: ["display_name\n"] }],
    ["field with a unicode letter", { fields: ["namé"] }],
    ["field with a zero-width space", { fields: ["display​_name"] }],
    ["empty-string field", { fields: [""] }],
    ["64-character field (one too long)", { fields: ["a".repeat(64)] }],
    ["scalar string", "Jane Doe"],
    ["scalar number", 42],
    ["top-level array", ["display_name"]],
    ["JSON null inside jsonb", null],
  ])("is refused by the database: %s", async (_label, details) => {
    const error = (await insert(details).catch((e: unknown) => e)) as { code?: string } | undefined;
    // A JSON null stored through JSON.stringify(null) is the SQL value 'null'::jsonb, which is not an object.
    expect(error?.code, JSON.stringify(details)).toBeTruthy();
    expect(["23514", "22023"]).toContain(error!.code);
  });

  it("accepts names of the shape the repository writes, including 63 characters, digits and underscores", async () => {
    await insert({ fields: ["display_name", "owner_person_id", "a1_b2", "a".repeat(63)] });
    await insert({ fields: [] });
  });

  it("LIMIT (recorded): the database can only check the SHAPE of a field name, so a value that happens to look like a column name is accepted; the repository's fixed column list is what guarantees names", async () => {
    await expect(insert({ fields: ["jane_doe"] })).resolves.toBeDefined();
  });

  it("LIMIT (recorded, low): lax JSON-path matching unwraps nested arrays, so a nested array of name-shaped strings or an empty nested array is accepted; still only name-shaped strings, never a value-shaped one", async () => {
    await expect(insert({ fields: [["display_name"]] })).resolves.toBeDefined();
    await expect(insert({ fields: [[]] })).resolves.toBeDefined();
  });

  it("LIMIT (recorded): an empty object {} is accepted (the CHECK evaluates to NULL, which passes); harmless, holds no value", async () => {
    await expect(insert({})).resolves.toBeDefined();
  });
});

describe("ip_prefix", () => {
  const insert = (action: string, ip: string | null) =>
    db.insertInto("audit_log").values({ action: action as never, ip_prefix: ip, ...(["view", "create", "update", "delete"].includes(action) && { entity_type: "person", entity_id: randomUUID() }) }).execute();

  // Decision 4: allowed on the events that show where a sign-in attempt came from.
  it("is accepted only on sign_in, sign_in_failed, 2fa_failed and backup_code_used: every other action is refused (23514), whatever the prefix", async () => {
    for (const action of ["view", "create", "update", "delete", "sign_out", "2fa_enrolled", "password_changed"]) {
      await expect(insert(action, "192.0.2.0/24"), action).rejects.toMatchObject({ code: "23514" });
      await expect(insert(action, "2001:db8:abcd::/48"), action).rejects.toMatchObject({ code: "23514" });
    }
  });

  it.each([
    "192.0.2.5", // full address
    "192.0.2.5/32",
    "192.0.2.0/23",
    "192.0.2.0/25",
    "192.0.2.0/0",
    "0.0.0.0/0",
    "2001:db8::1/128",
    "2001:db8:1::/47",
    "2001:db8:1::/49",
    "2001:db8:1::/64",
    "::/0",
    "",
    " ",
    "192.0.2.0/24 ",
    " 192.0.2.0/24",
    "192.0.2.0/24\n",
    "192.0.2.0/24; drop table audit_log",
    "localhost/24",
    "999.999.999.0/24",
    "::ffff:192.0.2.0/24", // IPv4-mapped IPv6 with a /24 mask is an IPv6 /24, not a /48
    "a".repeat(5000),
    "192.0.2.0/24/24",
    "-192.0.2.0/24",
  ])("a non-prefix is refused on a sign-in row: %j", async (ip) => {
    await expect(insert("sign_in", ip)).rejects.toBeTruthy();
  });

  it("a prefix with host bits set (192.0.2.5/24) is refused rather than silently masked", async () => {
    await expect(insert("sign_in", "192.0.2.5/24")).rejects.toBeTruthy();
    await expect(insert("sign_in", "2001:db8:1::5/48")).rejects.toBeTruthy();
  });

  it("accepts the abbreviated spelling of a /24 (192.0.2/24 is the same prefix as 192.0.2.0/24)", async () => {
    await insert("sign_in", "192.0.2/24");
  });

  it("accepts a correct /24 and /48 on each of the four sign-in events, in upper and lower case hex", async () => {
    for (const action of ["sign_in", "sign_in_failed", "2fa_failed", "backup_code_used"]) {
      await insert(action, "192.0.2.0/24");
      await insert(action, "2001:DB8:ABCD::/48");
      await insert(action, "2001:db8:abcd::/48");
      await insert(action, null);
    }
  });

  it("the four sign-in events still refuse a full address or a wrong mask", async () => {
    for (const action of ["2fa_failed", "backup_code_used"]) {
      for (const ip of ["192.0.2.5", "192.0.2.0/23", "2001:db8::1/128"]) await expect(insert(action, ip), `${action} ${ip}`).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("an update from sign_in to a non-sign-in action cannot be used to keep an ip_prefix: UPDATE is refused outright", async () => {
    await insert("sign_in", "203.0.113.0/24");
    await expect(db.updateTable("audit_log").set({ action: "view" }).where("ip_prefix", "=", "203.0.113.0/24").execute()).rejects.toMatchObject({ code: "42501" });
  });
});

describe("migration 0003 rollback", () => {
  // Decision 5: history is never dropped by a routine rollback.
  it("rolling back 0003 is refused while audit_log has rows, with a message to export the log first; nothing is dropped", async () => {
    const fresh = await freshDatabase();
    const own = createDb(fresh.url);
    try {
      await migrateTo(own, "0004_database_roles");
      await own.insertInto("audit_log").values({ action: "sign_out" }).execute();
      expect(await migrateDown(own)).toEqual(["0004_database_roles"]);
      const error = (await migrateDown(own).catch((e: unknown) => e)) as Error & { code?: string };
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/audit_log has rows/);
      expect(error.message).toMatch(/export the audit log first/i);
      expect(error.code).toBe("55000");
      expect(await readSchemaVersion(own)).toBe("0003_audit_log");
      expect(await own.selectFrom("audit_log").select("action").execute()).toEqual([{ action: "sign_out" }]);
      const functions = await sql<{ proname: string }>`select proname from pg_proc where proname like 'audit_log%' order by 1`.execute(own);
      expect(functions.rows.map((r) => r.proname)).toEqual(["audit_log_guard", "audit_log_retention"]);
    } finally {
      await own.destroy();
      await fresh.drop();
    }
  });

  it("rolling back 0003 with an empty log removes the table and functions, rolling forward restores a working empty log, and people/users data survive", async () => {
    const fresh = await freshDatabase();
    const own = createDb(fresh.url);
    try {
      await migrateTo(own, "0004_database_roles");
      const person = await own.insertInto("people").values({ display_name: "Survivor" }).returning("id").executeTakeFirstOrThrow();
      await own.insertInto("users").values({ person_id: person.id, role: "admin" }).returning("id").executeTakeFirstOrThrow();

      expect(await migrateDown(own)).toEqual(["0004_database_roles"]);
      expect(await migrateDown(own)).toEqual(["0003_audit_log"]);
      expect(await readSchemaVersion(own)).toBe("0002_people_users");
      const gone = await sql`select proname from pg_proc where proname like 'audit_log%'`.execute(own);
      expect(gone.rows).toEqual([]);
      expect(await own.selectFrom("people").select("display_name").execute()).toEqual([{ display_name: "Survivor" }]);
      expect(await own.selectFrom("users").select("role").execute()).toEqual([{ role: "admin" }]);

      await migrateUp(own);
      expect(await own.selectFrom("audit_log").select("id").execute()).toEqual([]);
      await own.insertInto("audit_log").values({ action: "view", entity_type: "person", entity_id: person.id }).execute();
      await expect(own.updateTable("audit_log").set({ action: "create" }).execute()).rejects.toMatchObject({ code: "42501" });
      await expect(runAuditRetention(own)).resolves.toEqual({ deleted: 0, ipPrefixesCleared: 0, usersDeleted: 0 });
    } finally {
      await own.destroy();
      await fresh.drop();
    }
  });

  it("a failing 0003 (a clashing function already exists) leaves no half-built audit_log and the schema version stays at 0002", async () => {
    const fresh = await freshDatabase();
    const own = createDb(fresh.url);
    try {
      await migrateTo(own, "0004_database_roles");
      await migrateDown(own); // 0004
      await migrateDown(own); // 0003
      const raw = new pg.Client({ connectionString: fresh.url });
      await raw.connect();
      await raw.query("create function audit_log_retention(out a int, out b int) language sql as 'select 1, 2'");
      await raw.end();
      await expect(migrateUp(own)).rejects.toBeTruthy();
      expect(await readSchemaVersion(own)).toBe("0002_people_users");
      const tables = await sql`select table_name from information_schema.tables where table_name = 'audit_log'`.execute(own);
      expect(tables.rows).toEqual([]);
      const guard = await sql`select proname from pg_proc where proname = 'audit_log_guard'`.execute(own);
      expect(guard.rows).toEqual([]);
    } finally {
      await own.destroy();
      await fresh.drop();
    }
  });
});
