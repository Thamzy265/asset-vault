import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, type CompiledQuery } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditChange, auditViews, canCreateFor, canEdit, canManage, checkViewer, isOwner, visibleTo, type Viewer } from "../src/access.ts";
import { createDb } from "../src/client.ts";
import { migrateUp } from "../src/migrate.ts";
import { peopleRepository } from "../src/people.ts";
import type { Database } from "../src/schema.ts";
import { freshDatabase } from "./support/fresh-database.ts";
import { mintViewer } from "../src/viewer.ts";

// Review C2: the repository parses the viewer once per call and passes the parsed
// viewer through; and a write's audit row names exactly the columns it wrote, so a
// new field can't be written without being audited.

/** Bookkeeping columns every write sets; they are not the record's fields and are not listed. */
const STAMPS = new Set(["created_by_user_id", "updated_by_user_id"]);

let db: Kysely<Database>; // owner: setup and reading the log
let appDb: Kysely<Database>; // vault_app, with every compiled query captured
let drop: () => Promise<void>;
const queries: CompiledQuery[] = [];
let admin: Viewer;
let bea: Viewer;

beforeAll(async () => {
  const fresh = await freshDatabase();
  drop = fresh.drop;
  db = createDb(fresh.url);
  await migrateUp(db);
  appDb = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: fresh.appUrl, max: 2 }) }),
    log: (event) => {
      if (event.level === "query") queries.push(event.query);
    },
  });
  const seed = await db.insertInto("people").values([{ display_name: "Admin" }, { display_name: "Bea" }]).returning("id").execute();
  const users = await db
    .insertInto("users")
    .values([
      { role: "admin", person_id: seed[0]!.id },
      { role: "member", person_id: seed[1]!.id },
    ])
    .returning("id")
    .execute();
  admin = mintViewer({ userId: users[0]!.id, role: "admin", personId: seed[0]!.id });
  bea = mintViewer({ userId: users[1]!.id, role: "member", personId: seed[1]!.id });
});
afterAll(async () => {
  await db?.destroy();
  await appDb?.destroy();
  await drop?.();
});

/** The people columns a captured INSERT or UPDATE wrote, without the bookkeeping stamps. */
function writtenColumns(query: CompiledQuery): string[] {
  const insert = /^insert into "people" \(([^)]*)\)/.exec(query.sql);
  const update = /^update "people" set (.*?) where /.exec(query.sql);
  const columns = insert ? insert[1]!.split(", ") : update ? update[1]!.split(", ").map((part) => part.split(" = ")[0]!) : [];
  return columns.map((c) => c.replaceAll('"', "")).filter((c) => !STAMPS.has(c)).sort();
}

async function auditedFields(entityId: string, action: "create" | "update"): Promise<string[][]> {
  const rows = await db.selectFrom("audit_log").select("details").where("entity_id", "=", entityId).where("action", "=", action).orderBy("id").execute();
  return rows.map((r) => [...(r.details?.fields ?? [])].sort());
}

const peopleWrites = () => queries.filter((q) => /^(insert into|update) "people"/.test(q.sql));

describe("the audit row names exactly the columns written (review C2)", () => {
  it.each<[string, () => [Viewer, Record<string, unknown>]]>([
    ["name only (admin, no owner)", () => [admin, { displayName: "Only a name" }]],
    ["name and owner", () => [bea, { displayName: "Owned", ownerPersonId: bea.personId }]],
    ["every field", () => [bea, { displayName: "All", relationship: "aunt", ownerPersonId: bea.personId, visibility: "private" }]],
    ["relationship null given", () => [admin, { displayName: "Null rel", relationship: null }]],
  ])("create, %s", async (_label, make) => {
    const [viewer, input] = make();
    const repo = peopleRepository(appDb);
    queries.length = 0;
    const p = await repo.create(viewer, input as never);
    const writes = peopleWrites();
    expect(writes).toHaveLength(1);
    expect(await auditedFields(p.id, "create")).toEqual([writtenColumns(writes[0]!)]);
  });

  it("update: the SET list and the audit row agree, for one and for several fields", async () => {
    const repo = peopleRepository(appDb);
    const p = await repo.create(bea, { displayName: "To change", ownerPersonId: bea.personId });
    for (const changes of [{ displayName: "Changed" }, { relationship: "sister", visibility: "private" as const }]) {
      queries.length = 0;
      await repo.update(bea, p.id, changes);
      const writes = peopleWrites();
      expect(writes).toHaveLength(1);
      expect((await auditedFields(p.id, "update")).at(-1)).toEqual(writtenColumns(writes[0]!));
    }
  });
});

describe("the access helpers take only a parsed viewer (review C2)", () => {
  const row = { id: randomUUID(), owner_person_id: null, visibility: "family" };

  it("checkViewer's result is accepted by every helper", () => {
    const v = checkViewer(mintViewer({ userId: randomUUID(), role: "admin", personId: null }));
    expect([isOwner(v, "people", row), canManage(v, "people", row), canEdit(v, "people", row), canCreateFor(v, null)]).toEqual([false, true, true, true]);
    expect(visibleTo(v, "people")).toBeDefined();
  });

  // Checked by `pnpm typecheck`: an unparsed Viewer is a type error, so each repository
  // function parses once (checkViewer) and passes the result through.
  function typeOnly(raw: Viewer, trx: never) {
    // @ts-expect-error an unparsed viewer
    isOwner(raw, "people", row);
    // @ts-expect-error an unparsed viewer
    canManage(raw, "people", row);
    // @ts-expect-error an unparsed viewer
    canEdit(raw, "people", row);
    // @ts-expect-error an unparsed viewer
    canCreateFor(raw, null);
    // @ts-expect-error an unparsed viewer
    visibleTo(raw, "people");
    // @ts-expect-error an unparsed viewer
    void auditChange(trx, raw, "create", "person", row.id);
    // @ts-expect-error an unparsed viewer
    void auditViews(trx, () => {}, raw, "person", [row.id]);
  }
  it("(type-level checks compile)", () => {
    expect(typeOnly).toBeTypeOf("function");
  });
});
