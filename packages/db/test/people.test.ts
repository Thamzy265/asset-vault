import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { migrateUp } from "../src/migrate.ts";
import { NotFoundError, PersonInUseError, ValidationError, type Viewer } from "../src/access.ts";
import { peopleRepository, type Person } from "../src/people.ts";
import type { Database } from "../src/schema.ts";
import { freshDatabase } from "./support/fresh-database.ts";

// M1.2 AC2 and AC4: every read and write goes through one visibility check, and
// every change has its audit row in the same transaction.
let db: Kysely<Database>;
let drop: () => Promise<void>;
let logged: Array<{ level: string; msg: string; fields: Record<string, unknown> }>;
let people: ReturnType<typeof peopleRepository>;

let admin: Viewer;
let bea: Viewer; // member, owns a private person
let carl: Viewer; // another member
let nobody: Viewer; // member with no linked person

async function user(role: "admin" | "member", personId: string | null): Promise<Viewer> {
  const row = await db.insertInto("users").values({ role, person_id: personId }).returning("id").executeTakeFirstOrThrow();
  return { userId: row.id, role, personId };
}

async function auditRows(entityId?: string) {
  let q = db.selectFrom("audit_log").selectAll().orderBy("id");
  if (entityId) q = q.where("entity_id", "=", entityId);
  return q.execute();
}

async function breakAuditInserts(): Promise<() => Promise<void>> {
  await sql`create function test_fail_audit() returns trigger language plpgsql as $$
    begin raise exception 'audit insert failed (test)'; end $$`.execute(db);
  await sql`create trigger test_fail_audit before insert on audit_log for each row execute function test_fail_audit()`.execute(db);
  return async () => {
    await sql`drop trigger test_fail_audit on audit_log`.execute(db);
    await sql`drop function test_fail_audit()`.execute(db);
  };
}

beforeAll(async () => {
  const fresh = await freshDatabase();
  drop = fresh.drop;
  db = createDb(fresh.url);
  await migrateUp(db);
  logged = [];
  people = peopleRepository(db, { log: (level, msg, fields = {}) => logged.push({ level, msg, fields }) });

  const seed = await db.insertInto("people").values([{ display_name: "Seed Admin" }, { display_name: "Seed Bea" }, { display_name: "Seed Carl" }]).returning("id").execute();
  admin = await user("admin", seed[0]!.id);
  bea = await user("member", seed[1]!.id);
  carl = await user("member", seed[2]!.id);
  nobody = await user("member", null);
});
afterAll(async () => {
  await db?.destroy();
  await drop?.();
});

describe("visibility (AC2)", () => {
  let privateOfBea: Person;
  let privateNoOwner: Person;
  let family: Person;

  beforeAll(async () => {
    privateOfBea = await people.create(bea, { displayName: "Bea's private", ownerPersonId: bea.personId, visibility: "private" });
    privateNoOwner = await people.create(admin, { displayName: "Unowned private", visibility: "private" });
    family = await people.create(carl, { displayName: "Family person" });
  });

  it("family records are visible to every signed-in user", async () => {
    for (const viewer of [admin, bea, carl, nobody]) {
      await expect(people.get(viewer, family.id)).resolves.toMatchObject({ id: family.id, visibility: "family" });
    }
  });

  it("a private person is visible to its owner's linked user and to an admin", async () => {
    await expect(people.get(bea, privateOfBea.id)).resolves.toMatchObject({ id: privateOfBea.id });
    await expect(people.get(admin, privateOfBea.id)).resolves.toMatchObject({ id: privateOfBea.id });
  });

  it("a private person is invisible to another member: get, update and delete all say not-found, list leaves it out", async () => {
    for (const viewer of [carl, nobody]) {
      await expect(people.get(viewer, privateOfBea.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(people.update(viewer, privateOfBea.id, { displayName: "Hijacked" })).rejects.toBeInstanceOf(NotFoundError);
      await expect(people.remove(viewer, privateOfBea.id)).rejects.toBeInstanceOf(NotFoundError);
      expect((await people.list(viewer)).map((p) => p.id)).not.toContain(privateOfBea.id);
    }
    expect((await people.get(bea, privateOfBea.id)).displayName).toBe("Bea's private");
  });

  it("a private person with no owner is visible to admins only", async () => {
    await expect(people.get(admin, privateNoOwner.id)).resolves.toMatchObject({ id: privateNoOwner.id });
    for (const viewer of [bea, carl, nobody]) {
      await expect(people.get(viewer, privateNoOwner.id)).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("an invisible id, an unknown id and a malformed id give the same not-found (ids can't be probed)", async () => {
    const errors = await Promise.all(
      [privateOfBea.id, randomUUID(), "not-a-uuid", "' or 1=1 --"].map((id) => people.get(carl, id).catch((e: unknown) => e)),
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as Error).message).toBe((errors[0] as Error).message);
    }
  });

  it("list shows admins everything and members only what they may see", async () => {
    const all = (await people.list(admin)).map((p) => p.id);
    expect(all).toEqual(expect.arrayContaining([privateOfBea.id, privateNoOwner.id, family.id]));
    const forBea = (await people.list(bea)).map((p) => p.id);
    expect(forBea).toContain(privateOfBea.id);
    expect(forBea).not.toContain(privateNoOwner.id);
  });

  it("a member can't attach a record to an owner they can't see (create or update): not-found", async () => {
    await expect(people.create(carl, { displayName: "X", ownerPersonId: privateOfBea.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(people.update(carl, family.id, { ownerPersonId: privateNoOwner.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(people.create(carl, { displayName: "X", ownerPersonId: randomUUID() })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a viewer that isn't well-formed instead of guessing a role", async () => {
    const bad = [
      { ...carl, role: "superadmin" },
      { ...carl, role: "Admin" },
      { ...carl, userId: "x" },
      { ...carl, personId: "x" },
    ] as unknown as Viewer[];
    for (const viewer of bad) await expect(people.get(viewer, family.id)).rejects.toThrow(/viewer/i);
  });
});

describe("writes and their audit rows (AC4)", () => {
  it("create returns the person, stamps who created it, and writes a create row with field names only", async () => {
    const created = await people.create(bea, { displayName: "Dana Secretname", relationship: "cousin" });
    expect(created).toMatchObject({ displayName: "Dana Secretname", relationship: "cousin", visibility: "family", ownerPersonId: null, createdByUserId: bea.userId, updatedByUserId: bea.userId });
    const rows = await auditRows(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "create", actor_user_id: bea.userId, entity_type: "person", entity_id: created.id, ip_prefix: null });
    expect(rows[0]?.details?.fields.sort()).toEqual(["display_name", "relationship"]);
    expect(JSON.stringify(rows)).not.toMatch(/Secretname|cousin/);
  });

  it("update writes an update row naming only the fields that changed, never their values", async () => {
    const p = await people.create(bea, { displayName: "Eve Oldname", relationship: "aunt" });
    const updated = await people.update(carl, p.id, { displayName: "Eve Newname", relationship: "aunt" });
    expect(updated).toMatchObject({ displayName: "Eve Newname", relationship: "aunt", updatedByUserId: carl.userId, createdByUserId: bea.userId });
    const rows = (await auditRows(p.id)).filter((r) => r.action === "update");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: carl.userId, details: { fields: ["display_name"] } });
    expect(JSON.stringify(await auditRows(p.id))).not.toMatch(/Oldname|Newname|aunt/);
  });

  it("an update that changes nothing writes nothing", async () => {
    const p = await people.create(bea, { displayName: "Same" });
    await people.update(bea, p.id, { displayName: "Same" });
    expect((await auditRows(p.id)).map((r) => r.action)).toEqual(["create"]);
  });

  it("delete removes the person and writes a delete row", async () => {
    const p = await people.create(bea, { displayName: "Gone" });
    await people.remove(admin, p.id);
    await expect(people.get(admin, p.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await auditRows(p.id)).map((r) => [r.action, r.actor_user_id])).toEqual([["create", bea.userId], ["delete", admin.userId]]);
  });

  it("delete is refused while the person owns records, writes no audit row, and works after reassigning", async () => {
    const owner = await people.create(bea, { displayName: "Owner" });
    const child = await people.create(bea, { displayName: "Child", ownerPersonId: owner.id });
    await expect(people.remove(bea, owner.id)).rejects.toBeInstanceOf(PersonInUseError);
    await expect(people.get(bea, owner.id)).resolves.toBeDefined();
    expect((await auditRows(owner.id)).map((r) => r.action)).toEqual(["create", "view"]);
    await people.update(bea, child.id, { ownerPersonId: null });
    await people.remove(bea, owner.id);
  });

  it("delete is refused while the person is linked to a login", async () => {
    await expect(people.remove(admin, bea.personId!)).rejects.toBeInstanceOf(PersonInUseError);
  });

  it("no change without its audit row: when the audit insert fails, create, update and delete all roll back", async () => {
    const p = await people.create(bea, { displayName: "Stays" });
    const before = await db.selectFrom("people").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow();
    const restore = await breakAuditInserts();
    try {
      await expect(people.create(bea, { displayName: "Never saved" })).rejects.toThrow();
      await expect(people.update(bea, p.id, { displayName: "Never renamed" })).rejects.toThrow();
      await expect(people.remove(bea, p.id)).rejects.toThrow();
    } finally {
      await restore();
    }
    const after = await db.selectFrom("people").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
    expect((await people.get(bea, p.id)).displayName).toBe("Stays");
  });

  it("a failed insert (over-length relationship, refused by the database) leaves no person and no audit row", async () => {
    const audits = (await auditRows()).length;
    await expect(people.create(bea, { displayName: "Valid", relationship: "x".repeat(51) })).rejects.toMatchObject({ code: "23514" });
    expect((await auditRows()).length).toBe(audits);
  });
});

describe("reads and their view rows", () => {
  it("get writes one view row for the record", async () => {
    const p = await people.create(bea, { displayName: "Viewed" });
    await people.get(carl, p.id);
    const views = (await auditRows(p.id)).filter((r) => r.action === "view");
    expect(views).toMatchObject([{ actor_user_id: carl.userId, entity_type: "person", entity_id: p.id, details: null }]);
  });

  it("list writes one view row per record returned, and none for records left out", async () => {
    const hidden = await people.create(bea, { displayName: "Hidden", ownerPersonId: bea.personId, visibility: "private" });
    const start = (await auditRows()).length;
    const listed = await people.list(carl);
    const views = (await auditRows()).slice(start);
    expect(views.every((r) => r.action === "view" && r.actor_user_id === carl.userId)).toBe(true);
    expect(views.map((r) => r.entity_id).sort()).toEqual(listed.map((p) => p.id).sort());
    expect(views.map((r) => r.entity_id)).not.toContain(hidden.id);
  });

  it("a not-found read writes no view row", async () => {
    const start = (await auditRows()).length;
    await people.get(carl, randomUUID()).catch(() => {});
    expect((await auditRows()).length).toBe(start);
  });

  it("a failed view-audit write never fails the read; it logs an error with ids and code only", async () => {
    const p = await people.create(bea, { displayName: "Readable Secretname" });
    logged.length = 0;
    const restore = await breakAuditInserts();
    try {
      await expect(people.get(carl, p.id)).resolves.toMatchObject({ id: p.id });
      await expect(people.list(carl)).resolves.not.toHaveLength(0);
    } finally {
      await restore();
    }
    expect(logged).toHaveLength(2);
    for (const line of logged) {
      expect(line).toMatchObject({ level: "error", msg: "audit view write failed", fields: { entityType: "person", code: "P0001" } });
    }
    expect(JSON.stringify(logged)).not.toMatch(/Secretname|audit insert failed/);
  });
});

describe("input checks at the repository boundary (B2, B4, B5)", () => {
  const bad = <T>(value: unknown) => value as T;

  it("create refuses a non-object input, unknown fields and wrongly typed fields with a ValidationError naming the field, never its value", async () => {
    const before = (await auditRows()).length;
    const cases: Array<[unknown, string[]]> = [
      [null, ["(input)"]],
      ["Jane", ["(input)"]],
      [[], ["(input)"]],
      [{}, ["displayName"]],
      [{ displayName: "Jane Valuename", relationship: 7 }, ["relationship"]],
      [{ displayName: "Jane Valuename", ownerPersonId: 7 }, ["ownerPersonId"]],
      [{ displayName: "Jane Valuename", visibility: null }, ["visibility"]],
      [{ displayName: "Jane Valuename", createdByUserId: admin.userId }, ["(unknown field)"]],
      [{ displayName: "Jane Valuename", id: randomUUID() }, ["(unknown field)"]],
    ];
    for (const [input, fields] of cases) {
      const error = await people.create(admin, bad(input)).catch((e: unknown) => e);
      expect(error, JSON.stringify(input)).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields, JSON.stringify(input)).toEqual(fields);
      expect((error as Error).message).not.toMatch(/Valuename|Jane/);
    }
    expect((await auditRows()).length).toBe(before);
  });

  it("update refuses a non-object change set, unknown fields and wrongly typed fields, and changes nothing", async () => {
    const p = await people.create(admin, { displayName: "Typed" });
    for (const changes of [null, "x", [], { displayName: 1 }, { relationship: {} }, { ownerPersonId: true }, { visibility: "" }, { updatedByUserId: admin.userId }]) {
      await expect(people.update(admin, p.id, bad(changes)), JSON.stringify(changes)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await people.get(admin, p.id)).toMatchObject({ displayName: "Typed", updatedAt: p.updatedAt });
  });

  it("a malformed owner id is not-found, the same as an unknown one (ids can't be probed)", async () => {
    await expect(people.create(admin, { displayName: "X", ownerPersonId: "not-a-uuid" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("ids are compared case-insensitively: an uppercase viewer, record or owner id is the same id, stored and returned in lowercase", async () => {
    const owner = await people.create(admin, { displayName: "Case owner" });
    const upperViewer: Viewer = { userId: admin.userId.toUpperCase(), role: "admin", personId: admin.personId!.toUpperCase() };
    const child = await people.create(upperViewer, { displayName: "Case child", ownerPersonId: owner.id.toUpperCase() });
    expect(child.ownerPersonId).toBe(owner.id);
    expect(child.createdByUserId).toBe(admin.userId);
    const before = (await auditRows(child.id)).length;
    await people.update(upperViewer, child.id.toUpperCase(), { ownerPersonId: owner.id.toUpperCase() });
    expect((await auditRows(child.id)).length).toBe(before);
    const privateOfBea = await people.create(admin, { displayName: "Case private", ownerPersonId: bea.personId, visibility: "private" });
    const upperBea: Viewer = { ...bea, userId: bea.userId.toUpperCase(), personId: bea.personId!.toUpperCase() };
    await expect(people.get(upperBea, privateOfBea.id.toUpperCase())).resolves.toMatchObject({ id: privateOfBea.id });
  });
});

describe("name rules (decision 6, B1)", () => {
  // Names the repository refuses that Postgres can store as text (no NUL, no lone surrogate):
  // the database check must refuse them too, so a raw insert can't bypass the rule.
  const refused = ["", "   ", "\t", "\u00a0", "\u200b", " \u200b ", "\u200e", "\ufe0f", "a\tb", "a\u007fb", "a\u0085b", "Ann\u202eabc", "\u2067Ann", "a".repeat(101), "\u{1f600}".repeat(101), "e\u0301".repeat(51)];
  // Names the repository stores (already trimmed): the database check must accept them.
  const stored = ["Jane", "x", "a".repeat(100), "\u{1f600}".repeat(100), "\u540d\u524d\u3000\u5168", "\u{1f468}\u200d\u{1f469}", "Anna \u05e2\u05d1 Anna", "a\u200bb"];

  it("the repository refuses a bad name on create and update with a ValidationError naming displayName", async () => {
    const p = await people.create(admin, { displayName: "Valid" });
    for (const name of [...refused, "a\u0000b", "bad\ud800name"]) {
      const created = await people.create(admin, { displayName: name }).catch((e: unknown) => e);
      expect(created, JSON.stringify(name)).toBeInstanceOf(ValidationError);
      expect((created as ValidationError).fields).toEqual(["displayName"]);
      await expect(people.update(admin, p.id, { displayName: name }), JSON.stringify(name)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("the repository stores the trimmed name", async () => {
    await expect(people.create(admin, { displayName: "\u3000 Trimmed \n" })).resolves.toMatchObject({ displayName: "Trimmed" });
  });

  it("the database check matches: a raw insert of a refused name fails (23514), of a stored name succeeds", async () => {
    for (const name of refused) {
      const result = await sql`insert into people (display_name) values (${name})`.execute(db).then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
      expect(result, JSON.stringify(name)).toBe("23514");
    }
    for (const name of stored) {
      await expect(sql`insert into people (display_name) values (${name})`.execute(db), JSON.stringify(name)).resolves.toBeDefined();
    }
  });

  it("the database refuses untrimmed names too (the repository never writes one)", async () => {
    for (const name of [" Jane", "Jane ", "\u3000Jane", "Jane\u00a0", "\nJane"]) {
      const result = await sql`insert into people (display_name) values (${name})`.execute(db).then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
      expect(result, JSON.stringify(name)).toBe("23514");
    }
  });
});
