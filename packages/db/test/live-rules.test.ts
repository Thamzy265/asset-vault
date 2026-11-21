import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { migrateUp } from "../src/migrate.ts";
import { normaliseDisplayName, normaliseRelationship } from "../src/names.ts";
import { AUDIT_ACTIONS, IP_PREFIX_ACTIONS, VISIBILITIES } from "../src/rules.ts";
import type { Database } from "../src/schema.ts";
import { freshDatabase } from "./support/fresh-database.ts";

// Review L6: live code takes its rules from src/rules.ts, never from a migration
// file (merged migrations are frozen; a rule change is a new migration). This
// file checks that the live rules still match the constraints on a migrated
// database, by evaluating each constraint's own expression (read back from
// pg_constraint) over candidate values.

const SRC = join(import.meta.dirname, "../src");

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

/** The boolean expression of a CHECK constraint, as Postgres stores it. */
async function checkExpression(table: string, name: string): Promise<string> {
  const row = await sql<{ def: string }>`
    select pg_get_constraintdef(c.oid) as def from pg_constraint c
    where c.conrelid = ${table}::regclass and c.conname = ${name} and c.contype = 'c'`.execute(db);
  const def = row.rows[0]?.def;
  if (!def) throw new Error(`no check constraint ${name} on ${table}`);
  const match = /^CHECK \((.*)\)$/s.exec(def);
  if (!match) throw new Error(`unexpected constraint text: ${def}`);
  return match[1]!;
}

/** The string literals in a constraint's text, so a value the database allows but the live list lacks is a candidate too. */
function literalsIn(expression: string): string[] {
  return [...expression.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replaceAll("''", "'"));
}

/** Evaluates `expression` once per value, with the value bound to `column` (and any fixed columns). */
async function accepted(expression: string, column: string, values: readonly string[], fixed: Record<string, string> = {}): Promise<Set<string>> {
  const fixedCols = Object.entries(fixed).map(([name, value]) => sql`${value}::text as ${sql.id(name)}`);
  const result = await sql<{ v: string; ok: boolean | null }>`
    select t.${sql.id(column)} as v, (${sql.raw(expression)}) as ok
    from (select v as ${sql.id(column)}${fixedCols.length > 0 ? sql`, ${sql.join(fixedCols)}` : sql``}
          from unnest(${values}::text[]) as u(v)) as t`.execute(db);
  // A CHECK passes on true or null.
  return new Set(result.rows.filter((r) => r.ok !== false).map((r) => r.v));
}

/** Values to try: the live list, every literal the constraint names, and some that neither allows. */
const candidates = (live: readonly string[], expression: string) => [...new Set([...live, ...literalsIn(expression), "", "nope", "VIEW", "Family"])];

describe("live rules match the migrated database (review L6)", () => {
  it("VISIBILITIES is exactly what people.visibility accepts", async () => {
    const expr = await checkExpression("people", "people_visibility_check");
    expect([...(await accepted(expr, "visibility", candidates(VISIBILITIES, expr)))].sort()).toEqual([...VISIBILITIES].sort());
  });

  it("AUDIT_ACTIONS is exactly what audit_log.action accepts", async () => {
    const expr = await checkExpression("audit_log", "audit_log_action_check");
    expect([...(await accepted(expr, "action", candidates(AUDIT_ACTIONS, expr)))].sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  it("IP_PREFIX_ACTIONS is exactly the set of actions that may carry an ip_prefix", async () => {
    const expr = await checkExpression("audit_log", "audit_log_ip_prefix");
    const values = candidates([...AUDIT_ACTIONS, ...IP_PREFIX_ACTIONS], expr);
    for (const prefix of ["192.0.2.0/24", "2001:db8:abcd::/48"]) {
      expect([...(await accepted(expr, "action", values, { ip_prefix: prefix }))].sort(), prefix).toEqual([...IP_PREFIX_ACTIONS].sort());
    }
  });

  /**
   * Every BMP code point (no surrogates, no NUL: Postgres text can't hold them) and the
   * astral ranges the classes touch, alone, as a leading or trailing character, and inside
   * a value; plus the length boundaries.
   */
  function textCandidates(maxCodePoints: number): string[] {
    const codePoints: number[] = [];
    const add = (from: number, to: number) => {
      for (let cp = from; cp <= to; cp++) if (cp < 0xd800 || cp > 0xdfff) codePoints.push(cp);
    };
    add(1, 0xffff);
    add(0x1bc90, 0x1bcaf);
    add(0x1d170, 0x1d17f);
    add(0xdfff0, 0xe1010);
    const values = codePoints.flatMap((cp) => {
      const ch = String.fromCodePoint(cp);
      return [ch, `${ch}a`, `a${ch}`, `a${ch}a`];
    });
    for (const n of [maxCodePoints, maxCodePoints + 1]) values.push("a".repeat(n), "\u{1f600}".repeat(n));
    return values;
  }
  const hex = (v: string) => [...v].map((c) => c.codePointAt(0)!.toString(16)).join(" ");

  it("display names: the database accepts a value exactly when the repository would store it unchanged", async () => {
    const expr = await checkExpression("people", "people_display_name_check");
    const values = [...textCandidates(100), ""];
    const dbAccepts = await accepted(expr, "display_name", values);
    const mismatches = values.filter((v) => dbAccepts.has(v) !== (normaliseDisplayName(v) === v));
    expect(mismatches.map(hex).slice(0, 20)).toEqual([]);
  });

  it("relationship (review L1): the database accepts a value exactly when the repository would store it unchanged", async () => {
    const expr = await checkExpression("people", "people_relationship_check");
    const values = [...textCandidates(50), ""];
    const dbAccepts = await accepted(expr, "relationship", values);
    const mismatches = values.filter((v) => dbAccepts.has(v) !== (normaliseRelationship(v) === v));
    expect(mismatches.map(hex).slice(0, 20)).toEqual([]);
  });
});

describe("live code never imports a migration file (review L6)", () => {
  // Only the migration runner and the schema version read the migration list.
  const ALLOWED = new Set(["migrate.ts", "schema-version.ts"]);

  it("no file in src/ outside migrations/ imports from ./migrations/, except the migration list readers", () => {
    const offenders = readdirSync(SRC, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith(".ts") && !ALLOWED.has(f.name))
      .filter((f) => /from\s+["']\.\/migrations\//.test(readFileSync(join(SRC, f.name), "utf8")))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it("the migration list readers import only migrations/index.ts", () => {
    for (const name of ALLOWED) {
      const specifiers = [...readFileSync(join(SRC, name), "utf8").matchAll(/from\s+["'](\.\/migrations\/[^"']+)["']/g)].map((m) => m[1]);
      expect(specifiers, name).toEqual(["./migrations/index.ts"]);
    }
  });
});
