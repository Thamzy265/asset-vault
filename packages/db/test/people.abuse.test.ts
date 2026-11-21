import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { migrateUp } from "../src/migrate.ts";
import { ForbiddenError, NotFoundError, PersonInUseError, ValidationError, type Viewer } from "../src/access.ts";
import { peopleRepository, type Person } from "../src/people.ts";
import type { Database } from "../src/schema.ts";
import { freshDatabase } from "./support/fresh-database.ts";

// Tester (M1.2): abuse, edge and failure cases for the people repository and the
// visibility layer. Source of the abuse cases: docs/design/m1-2-data-model.md
// "Trust boundaries and abuse cases" (a member probes a private record by id;
// an invisible record looks exactly like a missing one).
//
// Bugs B1-B5 found in the tester round are fixed; their tests ("Was CONFIRMED BUG ...") assert the
// fixed behaviour. The former spec-question block now asserts the lead's decisions 1 and 2
// (docs/design/m1-2-data-model.md, "Lead decisions after the tester round"). The repository runs
// as vault_app (`appDb`), like web and worker; `db` is the owner, for setup and raw checks.
let db: Kysely<Database>; // as vault_migrator (owner): setup and raw checks
let appDb: Kysely<Database>; // as vault_app: the repository, as web and worker run it
let drop: () => Promise<void>;
let url: string;
let logged: Array<{ level: string; msg: string; fields: Record<string, unknown> }>;
let people: ReturnType<typeof peopleRepository>;

let admin: Viewer;
let bea: Viewer; // member, linked to a person
let carl: Viewer; // another member
let nobody: Viewer; // member with no linked person
let adminNoPerson: Viewer; // admin with no linked person

async function user(role: "admin" | "member", personId: string | null): Promise<Viewer> {
  const row = await db.insertInto("users").values({ role, person_id: personId }).returning("id").executeTakeFirstOrThrow();
  return { userId: row.id, role, personId };
}
const auditCount = async () => Number((await db.selectFrom("audit_log").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow()).n);
const peopleCount = async () => Number((await db.selectFrom("people").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow()).n);

beforeAll(async () => {
  const fresh = await freshDatabase();
  drop = fresh.drop;
  url = fresh.url;
  db = createDb(url);
  await migrateUp(db);
  logged = [];
  appDb = createDb(fresh.appUrl);
  people = peopleRepository(appDb, { log: (level, msg, fields = {}) => logged.push({ level, msg, fields }) });
  const seed = await db.insertInto("people").values([{ display_name: "A" }, { display_name: "B" }, { display_name: "C" }]).returning("id").execute();
  admin = await user("admin", seed[0]!.id);
  bea = await user("member", seed[1]!.id);
  carl = await user("member", seed[2]!.id);
  nobody = await user("member", null);
  adminNoPerson = await user("admin", null);
});
afterAll(async () => {
  await db?.destroy();
  await appDb?.destroy();
  await drop?.();
});

describe("id forms: every repository function answers not-found, never anything else (design note abuse case 1)", () => {
  let hidden: Person;
  beforeAll(async () => {
    hidden = await people.create(bea, { displayName: "Hidden", ownerPersonId: bea.personId, visibility: "private" });
  });

  const forms: Array<[string, (id: string) => string]> = [
    ["uppercase uuid of the hidden record", (id) => id.toUpperCase()],
    ["uuid with braces", (id) => `{${id}}`],
    ["uuid without dashes", (id) => id.replaceAll("-", "")],
    ["uuid with urn prefix", (id) => `urn:uuid:${id}`],
    ["uuid with surrounding spaces", (id) => ` ${id} `],
    ["uuid with trailing newline", (id) => `${id}\n`],
    ["uuid with a null byte", (id) => `${id}\u0000`],
    ["uuid plus SQL comment", (id) => `${id}'--`],
    ["quote injection", () => "' or '1'='1"],
    ["union injection", () => "00000000-0000-0000-0000-000000000000' union select id from people --"],
    ["semicolon injection", () => "x'; drop table people; --"],
    ["empty string", () => ""],
    ["whitespace", () => "   "],
    ["very long string (1 MB)", () => "a".repeat(1_000_000)],
    ["unicode lookalike digits", () => "٠٠٠٠٠٠٠٠-٠٠٠٠-٠٠٠٠-٠٠٠٠-٠٠٠٠٠٠٠٠٠٠٠٠"],
    ["nil uuid", () => "00000000-0000-0000-0000-000000000000"],
    ["random unknown uuid", () => randomUUID()],
  ];

  it.each(forms)("%s: get, update and remove give NotFoundError for a member and write nothing", async (_label, make) => {
    const id = make(hidden.id);
    const before = { audit: await auditCount(), people: await peopleCount() };
    for (const call of [
      () => people.get(carl, id),
      () => people.update(carl, id, { displayName: "Hijacked" }),
      () => people.remove(carl, id),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(NotFoundError);
    }
    expect({ audit: await auditCount(), people: await peopleCount() }).toEqual(before);
    expect((await people.get(bea, hidden.id)).displayName).toBe("Hidden");
  });

  it("an uppercase spelling of a VISIBLE record's id is not a way to a different answer than the lowercase one (admin gets it, member of a family record gets it)", async () => {
    const fam = await people.create(carl, { displayName: "Fam", ownerPersonId: carl.personId });
    const upper = fam.id.toUpperCase();
    // Either both spellings work or both are not-found; they must never differ by viewer in a way that leaks.
    const asCarl = await people.get(carl, upper).then(
      (p) => p.id,
      (e: unknown) => (e as Error).name,
    );
    const asAdmin = await people.get(admin, upper).then(
      (p) => p.id,
      (e: unknown) => (e as Error).name,
    );
    expect(asCarl).toBe(asAdmin);
    // And an uppercase id never reaches the hidden record for the wrong viewer.
    await expect(people.get(carl, hidden.id.toUpperCase())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an owner id in any bad form is not-found on create and update, and the person is not created", async () => {
    const before = await peopleCount();
    for (const owner of ["", "not-a-uuid", `{${hidden.id}}`, "' or 1=1 --", hidden.id.toUpperCase().slice(0, 35)]) {
      await expect(people.create(carl, { displayName: "X", ownerPersonId: owner })).rejects.toBeInstanceOf(NotFoundError);
      await expect(people.update(carl, hidden.id, { ownerPersonId: owner })).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(await peopleCount()).toBe(before);
  });

  it("list takes no filter, so there is nothing to smuggle in: it ignores extra arguments and never returns a hidden row to a member", async () => {
    const extra = people.list as unknown as (viewer: Viewer, filter: unknown) => Promise<Person[]>;
    for (const filter of [{ visibility: "private" }, { ownerPersonId: bea.personId }, { where: "1=1" }, "' or 1=1 --"]) {
      const ids = (await extra(carl, filter)).map((p) => p.id);
      expect(ids).not.toContain(hidden.id);
    }
  });
});

describe("who sees what: admin, member without a person, admin without a person", () => {
  let privOwnedByBea: Person;
  let privUnowned: Person;
  let fam: Person;
  beforeAll(async () => {
    privOwnedByBea = await people.create(admin, { displayName: "P1", ownerPersonId: bea.personId, visibility: "private" });
    privUnowned = await people.create(admin, { displayName: "P2", visibility: "private" });
    fam = await people.create(carl, { displayName: "F1", ownerPersonId: carl.personId });
  });

  it("an admin sees, edits and deletes everything, linked to a person or not", async () => {
    for (const viewer of [admin, adminNoPerson]) {
      const ids = (await people.list(viewer)).map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining([privOwnedByBea.id, privUnowned.id, fam.id]));
      await expect(people.get(viewer, privOwnedByBea.id)).resolves.toMatchObject({ id: privOwnedByBea.id });
    }
    const throwaway = await people.create(carl, { displayName: "Throwaway", ownerPersonId: carl.personId, visibility: "private" });
    await expect(people.update(adminNoPerson, throwaway.id, { displayName: "Edited by admin" })).resolves.toMatchObject({ displayName: "Edited by admin" });
    await expect(people.remove(adminNoPerson, throwaway.id)).resolves.toBeUndefined();
  });

  it("a member with no linked person sees family records only: never a private record, owned or not", async () => {
    const ids = (await people.list(nobody)).map((p) => p.id);
    expect(ids).toContain(fam.id);
    expect(ids).not.toContain(privOwnedByBea.id);
    expect(ids).not.toContain(privUnowned.id);
    for (const id of [privOwnedByBea.id, privUnowned.id]) await expect(people.get(nobody, id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a member with no linked person cannot see a private record whose owner is NULL (null = null must not match)", async () => {
    // SQL gotcha guard: `owner_person_id = $personId` with a null personId must never be true for null owners.
    await expect(people.get(nobody, privUnowned.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await people.list(nobody)).map((p) => p.id)).not.toContain(privUnowned.id);
  });

  it("a viewer whose role is admin but is spelled differently is rejected, not treated as admin or member", async () => {
    for (const role of ["ADMIN", "admin ", "root", "", null, undefined, 1]) {
      await expect(people.list({ ...carl, role } as unknown as Viewer)).rejects.toThrow(/viewer/i);
    }
  });

  it("a missing, null or non-object viewer is rejected for every function (never defaults to anything)", async () => {
    for (const viewer of [undefined, null, {}, "admin", 7, []] as unknown as Viewer[]) {
      await expect(people.get(viewer, fam.id)).rejects.toThrow(/viewer/i);
      await expect(people.list(viewer)).rejects.toThrow(/viewer/i);
      await expect(people.create(viewer, { displayName: "X" })).rejects.toThrow(/viewer/i);
      await expect(people.update(viewer, fam.id, { displayName: "X" })).rejects.toThrow(/viewer/i);
      await expect(people.remove(viewer, fam.id)).rejects.toThrow(/viewer/i);
    }
  });

  it("extra fields on a viewer (isAdmin, scope) are ignored: they can't widen what the viewer sees", async () => {
    const sneaky = { ...carl, isAdmin: true, role: "member", scope: "all", visibleTo: "true" } as unknown as Viewer;
    await expect(people.get(sneaky, privOwnedByBea.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("no oracle between 'does not exist' and 'exists but hidden'", () => {
  let hidden: Person;
  beforeAll(async () => {
    hidden = await people.create(bea, { displayName: "Oracle", ownerPersonId: bea.personId, visibility: "private" });
  });

  it("the errors are indistinguishable: same class, name, message, own properties, no cause, same JSON", async () => {
    const shapes: string[] = [];
    for (const id of [hidden.id, randomUUID()]) {
      for (const call of [
        (i: string) => people.get(carl, i),
        (i: string) => people.update(carl, i, { displayName: "z" }),
        (i: string) => people.remove(carl, i),
      ]) {
        const e = (await call(id).catch((x: unknown) => x)) as Error;
        shapes.push(
          JSON.stringify([e.constructor.name, e.name, e.message, Object.getOwnPropertyNames(e).filter((p) => p !== "stack"), e.cause ?? null, JSON.stringify(e)]),
        );
      }
    }
    // get/update/remove x (hidden, unknown): 3 distinct call shapes, each pair of hidden/unknown equal.
    expect(shapes[0]).toBe(shapes[3]);
    expect(shapes[1]).toBe(shapes[4]);
    expect(shapes[2]).toBe(shapes[5]);
    expect(new Set(shapes).size).toBe(1);
  });

  it("the database is asked exactly the same statements for a hidden id as for an unknown one (so timing differs only by noise)", async () => {
    const statements: string[] = [];
    const spy = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 1 }) }),
      log: (event) => {
        if (event.level === "query") statements.push(event.query.sql);
      },
    });
    try {
      const repo = peopleRepository(spy, { log: () => {} });
      const trace = async (id: string, call: (i: string) => Promise<unknown>) => {
        statements.length = 0;
        await call(id).catch(() => {});
        return [...statements];
      };
      for (const call of [
        (i: string) => repo.get(carl, i),
        (i: string) => repo.update(carl, i, { displayName: "z" }),
        (i: string) => repo.remove(carl, i),
      ]) {
        const forHidden = await trace(hidden.id, call);
        const forUnknown = await trace(randomUUID(), call);
        expect(forHidden.length).toBeGreaterThan(0);
        expect(forHidden).toEqual(forUnknown);
      }
    } finally {
      await spy.destroy();
    }
  });

  it("a hidden and an unknown id write no view row and no audit row of any kind", async () => {
    const before = await auditCount();
    await people.get(carl, hidden.id).catch(() => {});
    await people.get(carl, randomUUID()).catch(() => {});
    await people.update(carl, hidden.id, { displayName: "z" }).catch(() => {});
    await people.remove(carl, hidden.id).catch(() => {});
    expect(await auditCount()).toBe(before);
  });
});

describe("forged or stale viewer (the repository trusts the session; what happens if it lies)", () => {
  it("a viewer whose user id is not a real user can read, but the failed view audit is logged and never breaks the read", async () => {
    const ghost: Viewer = { userId: randomUUID(), role: "member", personId: null };
    const fam = await people.create(carl, { displayName: "Seen by ghost", ownerPersonId: carl.personId });
    logged.length = 0;
    await expect(people.get(ghost, fam.id)).resolves.toMatchObject({ id: fam.id });
    expect(logged.some((l) => l.level === "error" && l.msg === "audit view write failed")).toBe(true);
    expect(JSON.stringify(logged)).not.toContain("Seen by ghost");
  });

  it("a viewer whose user id is not a real user cannot write: the whole change rolls back (no change without an audit row)", async () => {
    const ghost: Viewer = { userId: randomUUID(), role: "admin", personId: null };
    const before = { audit: await auditCount(), people: await peopleCount() };
    await expect(people.create(ghost, { displayName: "Ghost write" })).rejects.toMatchObject({ code: "23503" });
    expect({ audit: await auditCount(), people: await peopleCount() }).toEqual(before);
  });
});

describe("transaction integrity and concurrency", () => {
  it("an update that changes nothing writes no audit row, does not move updated_at, and is not charged to the viewer", async () => {
    const p = await people.create(admin, { displayName: "Same", relationship: "x" });
    const before = await auditCount();
    const again = await people.update(carl, p.id, { displayName: "Same", relationship: "x", visibility: "family", ownerPersonId: null });
    expect(again.updatedAt).toEqual(p.updatedAt);
    expect(again.updatedByUserId).toBe(admin.userId);
    expect(await auditCount()).toBe(before);
  });

  it("an empty change set writes nothing and returns the person", async () => {
    const p = await people.create(bea, { displayName: "Empty change", ownerPersonId: bea.personId });
    const before = await auditCount();
    await expect(people.update(bea, p.id, {})).resolves.toMatchObject({ id: p.id });
    await expect(people.update(bea, p.id, { displayName: undefined } as never)).resolves.toMatchObject({ id: p.id });
    expect(await auditCount()).toBe(before);
  });

  it("setting relationship to null on a person that has none is a no-op, but clearing a real one is an update that names only that field", async () => {
    const p = await people.create(bea, { displayName: "Rel", ownerPersonId: bea.personId });
    const a = await auditCount();
    await people.update(bea, p.id, { relationship: null });
    expect(await auditCount()).toBe(a);
    await people.update(bea, p.id, { relationship: "sister" });
    await people.update(bea, p.id, { relationship: null });
    const rows = await db.selectFrom("audit_log").select("details").where("entity_id", "=", p.id).where("action", "=", "update").orderBy("id").execute();
    expect(rows.map((r) => r.details)).toEqual([{ fields: ["relationship"] }, { fields: ["relationship"] }]);
  });

  it("a failed update (hidden new owner) leaves the row, its updated_at and the audit log untouched", async () => {
    const hiddenOwner = await people.create(bea, { displayName: "Hidden owner", ownerPersonId: bea.personId, visibility: "private" });
    const p = await people.create(carl, { displayName: "Stays", ownerPersonId: carl.personId });
    const before = await auditCount();
    await expect(people.update(carl, p.id, { displayName: "Changed", ownerPersonId: hiddenOwner.id })).rejects.toBeInstanceOf(NotFoundError);
    expect(await people.get(carl, p.id)).toMatchObject({ displayName: "Stays", updatedAt: p.updatedAt });
    expect(await auditCount()).toBe(before + 1); // the one view row of the get above
  });

  it("an update with one invalid field (relationship too long) in a multi-field change applies none of the fields", async () => {
    const p = await people.create(carl, { displayName: "Atomic", relationship: "old", ownerPersonId: carl.personId });
    await expect(people.update(carl, p.id, { displayName: "New name", relationship: "x".repeat(51) })).rejects.toBeInstanceOf(ValidationError);
    expect(await people.get(carl, p.id)).toMatchObject({ displayName: "Atomic", relationship: "old" });
  });

  it("concurrent updates of different fields both apply, and each audit row names only its own field", async () => {
    const p = await people.create(carl, { displayName: "Race", relationship: "r0", ownerPersonId: carl.personId });
    await Promise.all([people.update(carl, p.id, { displayName: "Race 2" }), people.update(bea, p.id, { relationship: "r2" })]);
    expect(await people.get(admin, p.id)).toMatchObject({ displayName: "Race 2", relationship: "r2" });
    const rows = await db.selectFrom("audit_log").select(["details", "actor_user_id"]).where("entity_id", "=", p.id).where("action", "=", "update").execute();
    expect(rows.map((r) => r.details?.fields.join()).sort()).toEqual(["display_name", "relationship"]);
  });

  it("concurrent updates of the same field: one value wins, both are audited, none is lost or doubled", async () => {
    const p = await people.create(carl, { displayName: "Same field", ownerPersonId: carl.personId });
    const names = Array.from({ length: 8 }, (_, i) => `Writer ${i}`);
    await Promise.all(names.map((n, i) => people.update(i % 2 ? bea : carl, p.id, { displayName: n })));
    const final = await people.get(admin, p.id);
    expect(names).toContain(final.displayName);
    const rows = await db.selectFrom("audit_log").select("id").where("entity_id", "=", p.id).where("action", "=", "update").execute();
    expect(rows).toHaveLength(8);
  });

  it("concurrent identical updates produce exactly one audit row (the second sees the first and has nothing to change)", async () => {
    const p = await people.create(carl, { displayName: "Dup", ownerPersonId: carl.personId });
    await Promise.all(Array.from({ length: 5 }, () => people.update(carl, p.id, { displayName: "Dup renamed" })));
    const rows = await db.selectFrom("audit_log").select("id").where("entity_id", "=", p.id).where("action", "=", "update").execute();
    expect(rows).toHaveLength(1);
  });

  it("concurrent removes: one succeeds, the rest get not-found, exactly one delete row", async () => {
    const p = await people.create(carl, { displayName: "Doomed", ownerPersonId: carl.personId });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => people.remove(carl, p.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(NotFoundError);
    const rows = await db.selectFrom("audit_log").select("id").where("entity_id", "=", p.id).where("action", "=", "delete").execute();
    expect(rows).toHaveLength(1);
  });

  it("update racing remove: one wins; the loser says not-found; no orphan update row after the delete", async () => {
    for (let i = 0; i < 10; i++) {
      const p = await people.create(carl, { displayName: `Race ${i}`, ownerPersonId: carl.personId });
      const [u, r] = await Promise.allSettled([people.update(carl, p.id, { displayName: "Renamed" }), people.remove(carl, p.id)]);
      expect(r.status).toBe("fulfilled");
      if (u.status === "rejected") expect(u.reason).toBeInstanceOf(NotFoundError);
      const actions = (await db.selectFrom("audit_log").select("action").where("entity_id", "=", p.id).orderBy("id").execute()).map((a) => a.action);
      expect(actions.at(-1)).toBe("delete");
      expect(actions.filter((a) => a === "delete")).toHaveLength(1);
    }
  });

  it("delete racing a new record that takes the person as owner: either the delete is refused (PersonInUseError) or the owner link is refused; never a dangling owner", async () => {
    const owner = await people.create(carl, { displayName: "Racing owner", ownerPersonId: carl.personId });
    const results = await Promise.allSettled([
      people.remove(carl, owner.id),
      people.create(admin, { displayName: "Owned child", ownerPersonId: owner.id }),
    ]);
    const dangling = await sql<{ n: string }>`
      select count(*) as n from people c where c.owner_person_id is not null and not exists (select 1 from people o where o.id = c.owner_person_id)`.execute(db);
    expect(Number(dangling.rows[0]!.n)).toBe(0);
    for (const r of results) {
      if (r.status === "rejected") expect([NotFoundError, PersonInUseError].some((E) => r.reason instanceof E) || (r.reason as { code?: string }).code === "23503").toBe(true);
    }
  });

  it("a person that owns itself, or two people that own each other, can be updated and the lookups do not loop", async () => {
    const a = await people.create(carl, { displayName: "Cycle A", ownerPersonId: carl.personId });
    const b = await people.create(admin, { displayName: "Cycle B", ownerPersonId: a.id });
    await expect(people.update(carl, a.id, { ownerPersonId: b.id })).resolves.toMatchObject({ ownerPersonId: b.id });
    await expect(people.update(admin, a.id, { ownerPersonId: a.id })).resolves.toMatchObject({ ownerPersonId: a.id });
    await expect(people.get(carl, a.id)).resolves.toMatchObject({ id: a.id });
    // Deleting a member of the cycle is refused while another record still points at it.
    await expect(people.remove(admin, a.id)).rejects.toBeInstanceOf(PersonInUseError);
  });

  // Was CONFIRMED BUG B4 (low): ids are now normalised to lowercase at the repository boundary.
  it("B4: uppercase spelling of the owner id that is already the owner is a no-op (same person, same value), not a phantom update", async () => {
    const owner = await people.create(carl, { displayName: "Owner for case", ownerPersonId: carl.personId });
    const child = await people.create(admin, { displayName: "Child for case", ownerPersonId: owner.id });
    const before = await auditCount();
    await people.update(carl, child.id, { ownerPersonId: owner.id.toUpperCase() });
    expect(await auditCount()).toBe(before);
  });
});

describe("name and relationship inputs", () => {
  const make = (displayName: string, extra: Partial<Parameters<typeof people.create>[1]> = {}) => people.create(carl, { displayName, ownerPersonId: carl.personId, ...extra });

  it("length counts characters (code points), not bytes: 100 emoji (400 bytes) are accepted, 101 are refused", async () => {
    const hundred = "😀".repeat(100);
    expect((await make(hundred)).displayName).toBe(hundred);
    await expect(make("😀".repeat(101))).rejects.toBeInstanceOf(ValidationError);
  });

  it("100 vs 101 plain characters; 1 character; and the boundary for multi-byte letters (é as one code point)", async () => {
    expect((await make("a".repeat(100))).displayName).toHaveLength(100);
    await expect(make("a".repeat(101))).rejects.toBeInstanceOf(ValidationError);
    expect((await make("x")).displayName).toBe("x");
    expect((await make("é".repeat(100))).displayName).toHaveLength(100);
    await expect(make("é".repeat(101))).rejects.toBeInstanceOf(ValidationError);
  });

  it("a decomposed accent (e + U+0301) counts as two characters: 51 of them are 102 and are refused", async () => {
    await expect(make("é".repeat(51))).rejects.toBeInstanceOf(ValidationError);
    expect((await make("é".repeat(50))).displayName).toHaveLength(100);
  });

  it("an astral emoji family sequence (zero-width joiners) counts every code point: a 7-code-point family x 15 is refused", async () => {
    const family = "👨‍👩‍👧‍👦"; // 4 emoji + 3 ZWJ = 7 code points
    await expect(make(family.repeat(15))).rejects.toBeInstanceOf(ValidationError);
    expect((await make(family.repeat(14))).displayName).toBe(family.repeat(14));
  });

  it("unicode names round-trip unchanged: accents, CJK, Chichewa-style apostrophes, right-to-left, mixed direction", async () => {
    for (const name of ["José Müller-Núñez", "李小龍", "Chimwemwe Ng'oma", "محمد علي", "שלום עולם", "Anna עברית Anna", "O'Brien \"Jr\"", "名前　全角スペース"]) {
      const created = await make(name);
      expect(created.displayName).toBe(name);
      expect((await people.get(carl, created.id)).displayName).toBe(name);
    }
  });

  // Decision 6: the repository refuses a bad name (ValidationError) before the database is asked;
  // the database check matches (people.test.ts "the database check matches").
  it("leading and trailing Unicode whitespace is trimmed (decision 6), and the name is the same in get and list", async () => {
    const created = await make("  Padded Name\u00a0\u3000");
    expect(created.displayName).toBe("Padded Name");
    const got = await people.get(carl, created.id);
    expect(got.displayName).toBe("Padded Name");
    expect((await people.list(carl)).find((p) => p.id === created.id)?.displayName).toBe("Padded Name");
    const renamed = await people.update(carl, created.id, { displayName: "\tRenamed\n" });
    expect(renamed.displayName).toBe("Renamed");
  });

  it("a name of spaces only is refused", async () => {
    for (const blank of ["", " ", "     "]) await expect(make(blank)).rejects.toBeInstanceOf(ValidationError);
  });

  it("the shape of a rejected name is a ValidationError naming the field, never the value (so the API layer can map it)", async () => {
    const error = (await make("Secretvalue".repeat(10)).catch((e: unknown) => e)) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.fields).toEqual(["displayName"]);
    expect(error.message).not.toContain("Secretvalue");
  });

  it("a null byte in a name is refused, leaves no person and no audit row", async () => {
    const before = { audit: await auditCount(), people: await peopleCount() };
    await expect(make("Bad\u0000Name")).rejects.toBeTruthy();
    await expect(make("\u0000")).rejects.toBeTruthy();
    await expect(people.update(carl, (await make("Null update target")).id, { displayName: "a\u0000b" })).rejects.toBeTruthy();
    await expect(make("ok", { relationship: "a\u0000b" })).rejects.toBeTruthy();
    // the one successful create above (the update target) accounts for 1 person + 1 audit row
    expect({ audit: await auditCount(), people: await peopleCount() }).toEqual({ audit: before.audit + 1, people: before.people + 1 });
  });

  it("a lone surrogate (invalid UTF-16) is refused (decision 6), never stored as corrupt text", async () => {
    await expect(make("bad\uD800name")).rejects.toBeInstanceOf(ValidationError);
  });

  it("control characters inside a name are refused (decision 6)", async () => {
    for (const name of ["a\tb\nc", "a\u0007b", "a\u0085b"]) await expect(make(name), JSON.stringify(name)).rejects.toBeInstanceOf(ValidationError);
  });

  it("SQL metacharacters are data, not syntax", async () => {
    for (const name of ["'; drop table people; --", "Robert'); DROP TABLE people;--", "%_\\", "\\u0041", "$1", "{{template}}", "<script>alert(1)</script>"]) {
      const created = await make(name);
      expect((await people.get(carl, created.id)).displayName).toBe(name);
    }
    expect(await peopleCount()).toBeGreaterThan(0);
  });

  // Review L1: refused by the repository with a ValidationError naming the field, before the
  // database (whose 23514 error detail would carry the whole row, names included) is asked.
  it("relationship: 50 characters accepted, 51 refused (ValidationError), empty string accepted, emoji counted as characters", async () => {
    expect((await make("R50", { relationship: "r".repeat(50) })).relationship).toHaveLength(50);
    const error = await make("Secretname R51", { relationship: "r".repeat(51) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fields).toEqual(["relationship"]);
    expect(JSON.stringify(error)).not.toContain("Secretname");
    expect((error as Error).message).not.toContain("Secretname");
    expect((await make("R0", { relationship: "" })).relationship).toBe("");
    expect((await make("Rem", { relationship: "👪".repeat(50) })).relationship).toBe("👪".repeat(50));
    await expect(make("Rem51", { relationship: "👪".repeat(51) })).rejects.toBeInstanceOf(ValidationError);
  });

  it("relationship: trimmed; control, bidi override/isolate characters and lone surrogates refused on create and update", async () => {
    expect((await make("Rtrim", { relationship: "  aunt\u3000" })).relationship).toBe("aunt");
    expect((await make("Rpad", { relationship: ` ${"r".repeat(50)} ` })).relationship).toHaveLength(50);
    const target = await make("Rel target");
    for (const relationship of ["a\tb", "a\u0007b", "a\u0085b", "Ann\u202eabc", "\u2066x\u2069", "bad\ud800"]) {
      const created = await make("Rbad", { relationship }).catch((e: unknown) => e);
      expect(created, JSON.stringify(relationship)).toBeInstanceOf(ValidationError);
      expect((created as ValidationError).fields).toEqual(["relationship"]);
      await expect(people.update(carl, target.id, { relationship }), JSON.stringify(relationship)).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(people.update(carl, target.id, { relationship: " cousin " })).resolves.toMatchObject({ relationship: "cousin" });
  });

  it("an enormous name (1 MB) is refused, quickly, and writes nothing", async () => {
    const before = await peopleCount();
    await expect(make("x".repeat(1_000_000))).rejects.toBeInstanceOf(ValidationError);
    expect(await peopleCount()).toBe(before);
  });

  it("visibility outside family/private is refused by the repository (including the reserved 'restricted' and wrong case); the database check is in schema.abuse.test.ts", async () => {
    for (const visibility of ["restricted", "PRIVATE", "Family", "public", " private"]) {
      await expect(make("V", { visibility: visibility as never })).rejects.toBeInstanceOf(ValidationError);
      const owned = await make("V2");
      await expect(people.update(carl, owned.id, { visibility: visibility as never })).rejects.toBeInstanceOf(ValidationError);
    }
  });

  // Was CONFIRMED BUG B5 (low-medium, fails open): an explicit visibility is checked, never defaulted.
  it("B5: create with a falsy but explicit visibility ('' / null / 0 / false) is refused, not silently made family", async () => {
    const before = await peopleCount();
    for (const visibility of ["", null, 0, false]) {
      await expect(make("V3", { visibility: visibility as never }), String(visibility)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await peopleCount()).toBe(before);
  });

  it("a person refused for an invalid relationship leaves a clean audit trail: no create row for an id that does not exist", async () => {
    const before = await auditCount();
    await expect(make("Valid", { relationship: "x".repeat(51) })).rejects.toBeInstanceOf(ValidationError);
    expect(await auditCount()).toBe(before);
  });

  // Was CONFIRMED BUG B1 (low): blank is now Unicode-aware, in the repository and in the database check.
  it("B1: a name that is only tabs, newlines, no-break spaces or zero-width characters is refused (it is visually blank)", async () => {
    const before = await peopleCount();
    for (const blank of ["\t", "\n", " ", "​", " ", "　", " ​ "]) {
      await expect(make(blank), JSON.stringify(blank)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await peopleCount()).toBe(before);
  });

  // Was CONFIRMED BUG B2 (low): every input is type-checked at the repository boundary.
  it("B2: a non-string displayName (object, array, number, boolean) is refused instead of being coerced to text", async () => {
    const before = await peopleCount();
    for (const bad of [{ a: 1 }, ["x", "y"], 42, true]) {
      await expect(make(bad as never), JSON.stringify(bad)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await peopleCount()).toBe(before);
  });
});

describe("audit details: field names from a fixed list only, whatever the values are", () => {
  it("every create/update row names only the four known columns, even when values look like column names or are hostile", async () => {
    const known = new Set(["display_name", "relationship", "owner_person_id", "visibility"]);
    const p = await people.create(admin, { displayName: "display_name", relationship: "visibility", visibility: "private" });
    await people.update(admin, p.id, { displayName: "owner_person_id", relationship: '{"fields":["secret"]}', visibility: "family" });
    await people.update(admin, p.id, { displayName: "x".repeat(100) });
    const rows = await db.selectFrom("audit_log").select(["details", "action"]).where("entity_id", "=", p.id).where("action", "in", ["create", "update"]).execute();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(Object.keys(row.details ?? {})).toEqual(["fields"]);
      for (const f of row.details!.fields) expect(known.has(f), f).toBe(true);
    }
    expect(JSON.stringify(rows)).not.toContain("secret");
    expect(JSON.stringify(rows)).not.toContain("xxxxxxxx");
  });

  it("a create row lists exactly the fields the caller gave (not all columns), a delete row has no details", async () => {
    const p = await people.create(admin, { displayName: "Only name" });
    await people.remove(admin, p.id);
    const rows = await db.selectFrom("audit_log").select(["action", "details"]).where("entity_id", "=", p.id).orderBy("id").execute();
    expect(rows).toEqual([
      { action: "create", details: { fields: ["display_name"] } },
      { action: "delete", details: null },
    ]);
  });

  it("neither the name nor the relationship of anyone appears anywhere in audit_log or in the logged errors", async () => {
    const secretName = "Zyxwv Qrstuv Unique";
    const p = await people.create(carl, { displayName: secretName, relationship: "UniqueRelationship", ownerPersonId: carl.personId });
    await people.get(carl, p.id);
    await people.update(carl, p.id, { displayName: `${secretName} 2` });
    await people.remove(carl, p.id);
    const dump = JSON.stringify(await db.selectFrom("audit_log").selectAll().execute());
    expect(dump).not.toContain("Zyxwv");
    expect(dump).not.toContain("UniqueRelationship");
    expect(JSON.stringify(logged)).not.toContain("Zyxwv");
  });
});

// ---------------------------------------------------------------------------
// Was CONFIRMED BUG B3 (medium). Decided (decision 8): users are deactivated, not deleted; the
// audit FK is ON DELETE RESTRICT on purpose, and the retention job deletes a deactivated user once
// their last audit row has expired (audit-retention.test.ts).
describe("removing a login", () => {
  it("B3: deleting a user who has audit rows is refused (the audit FK is ON DELETE RESTRICT on purpose), and the rows keep their actor", async () => {
    const leaver = await user("admin", null);
    const p = await people.create(leaver, { displayName: "Created by a leaver" });
    await people.get(leaver, p.id);
    await expect(db.deleteFrom("users").where("id", "=", leaver.userId).execute()).rejects.toMatchObject({ code: "23001" });
    const actors = await db.selectFrom("audit_log").select("actor_user_id").where("entity_id", "=", p.id).execute();
    expect(actors.map((a) => a.actor_user_id)).toEqual([leaver.userId, leaver.userId]);
    const fk = await sql<{ confdeltype: string }>`
      select confdeltype from pg_constraint where conrelid = 'audit_log'::regclass and contype = 'f' and conkey = array[(
        select attnum from pg_attribute where attrelid = 'audit_log'::regclass and attname = 'actor_user_id')]::int2[]`.execute(db);
    expect(fk.rows).toEqual([{ confdeltype: "r" }]);
  });

  it("a user with no audit rows can be deleted, and the records they created keep existing with created_by set to null", async () => {
    const leaver = await user("member", null);
    const p = await db.insertInto("people").values({ display_name: "Orphaned creator", created_by_user_id: leaver.userId }).returning("id").executeTakeFirstOrThrow();
    await db.deleteFrom("users").where("id", "=", leaver.userId).execute();
    const row = await db.selectFrom("people").select("created_by_user_id").where("id", "=", p.id).executeTakeFirstOrThrow();
    expect(row.created_by_user_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SPEC QUESTIONS Q1-Q4, now DECIDED by the lead (docs/design/m1-2-data-model.md, "Lead decisions
// after the tester round", decisions 1 and 2). These tests assert the decided rules.
describe("decided write rules (were spec questions Q1-Q4)", () => {
  it("Q1a: a member can't reassign someone else's family record to their own person (no owner hijack): forbidden, nothing changes, no audit row", async () => {
    const victimOwned = await people.create(bea, { displayName: "Bea's record", ownerPersonId: bea.personId });
    const before = await auditCount();
    await expect(people.update(carl, victimOwned.id, { ownerPersonId: carl.personId })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await auditCount()).toBe(before);
    await expect(people.get(bea, victimOwned.id)).resolves.toMatchObject({ ownerPersonId: bea.personId });
  });

  it("Q1b: a member can't flip someone else's family record to private: forbidden, and everyone still sees it", async () => {
    const rec = await people.create(bea, { displayName: "Bea's visible record", ownerPersonId: bea.personId });
    await expect(people.update(carl, rec.id, { visibility: "private" })).rejects.toBeInstanceOf(ForbiddenError);
    for (const viewer of [bea, carl, nobody]) await expect(people.get(viewer, rec.id)).resolves.toMatchObject({ visibility: "family" });
  });

  it("Q1c: a member can edit the ordinary fields of a family record they don't own, but can't delete it", async () => {
    const rec = await people.create(bea, { displayName: "Bea's editable", ownerPersonId: bea.personId });
    await expect(people.update(carl, rec.id, { displayName: "Edited by Carl" })).resolves.toMatchObject({ displayName: "Edited by Carl" });
    await expect(people.remove(carl, rec.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(people.get(bea, rec.id)).resolves.toMatchObject({ displayName: "Edited by Carl" });
  });

  it("Q1d: a member can't create a record owned by someone else (forbidden); an admin can, and the owner then sees it", async () => {
    const before = await peopleCount();
    await expect(people.create(carl, { displayName: "Gift", ownerPersonId: bea.personId, visibility: "private" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await peopleCount()).toBe(before);
    const rec = await people.create(admin, { displayName: "Gift by admin", ownerPersonId: bea.personId, visibility: "private" });
    await expect(people.get(carl, rec.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(people.get(bea, rec.id)).resolves.toMatchObject({ id: rec.id });
  });

  it("Q2: a person owns their own record, so a member who sets THEIR OWN person to private still sees it and can make it family again", async () => {
    const mine = await db.insertInto("people").values({ display_name: "Dee" }).returning("id").executeTakeFirstOrThrow();
    const dee = await user("member", mine.id);
    await people.update(dee, mine.id, { visibility: "private" });
    await expect(people.get(dee, mine.id)).resolves.toMatchObject({ visibility: "private" });
    await expect(people.get(admin, mine.id)).resolves.toMatchObject({ visibility: "private" });
    await expect(people.get(carl, mine.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(people.update(dee, mine.id, { visibility: "family" })).resolves.toMatchObject({ visibility: "family" });
  });

  it("Q3: a member can't delete another member's person record, even one not linked to a login (forbidden); its owner and an admin can", async () => {
    const one = await people.create(carl, { displayName: "Unlinked person 1", ownerPersonId: carl.personId });
    const two = await people.create(carl, { displayName: "Unlinked person 2", ownerPersonId: carl.personId });
    await expect(people.remove(bea, one.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(people.remove(carl, one.id)).resolves.toBeUndefined();
    await expect(people.remove(admin, two.id)).resolves.toBeUndefined();
  });

  it("Q4 (unchanged at MVP, Later line 'Pagination for the people list'): every visible person is listed for every member, with no cap", async () => {
    const all = await people.list(carl);
    expect(all.length).toBeGreaterThan(5);
  });
});
