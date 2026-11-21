import { sql, type Kysely, type RawBuilder } from "kysely";
import { addUpdatedAtTrigger, withRecordColumns } from "./record-columns.ts";

/**
 * Character classes for display names (design note M1.2, decision 6), as
 * inclusive code point ranges. The database check below and the repository
 * (names.ts) are both built from these, so they can't drift apart; a test
 * checks each one against Unicode's own property.
 */
export type CodePointRange = readonly [number, number];
/** Unicode White_Space: trimmed from both ends. */
export const WHITE_SPACE: readonly CodePointRange[] = [
  [0x09, 0x0d], [0x20, 0x20], [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a],
  [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000],
];
/** Unicode Default_Ignorable_Code_Point: zero-width and other characters that render as nothing. */
export const INVISIBLE_CHARACTERS: readonly CodePointRange[] = [
  [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfff8], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff],
];
/** Unicode Cc. */
export const CONTROL_CHARACTERS: readonly CodePointRange[] = [
  [0x00, 0x1f], [0x7f, 0x9f],
];
/** Bidi embeddings, overrides (U+202A-U+202E) and isolates (U+2066-U+2069). */
export const BIDI_OVERRIDES_AND_ISOLATES: readonly CodePointRange[] = [
  [0x202a, 0x202e], [0x2066, 0x2069],
];
export const DISPLAY_NAME_MAX_CODE_POINTS = 100;

/** A Postgres regex bracket body for the ranges. NUL is left out: Postgres text can't hold it. */
function pgClass(...sets: ReadonlyArray<readonly CodePointRange[]>): string {
  const esc = (cp: number) => (cp > 0xffff ? `\\U${cp.toString(16).padStart(8, "0")}` : `\\u${cp.toString(16).padStart(4, "0")}`);
  return sets
    .flat()
    .map(([from, to]) => [Math.max(from, 1), to] as const)
    .map(([from, to]) => (from === to ? esc(from) : `${esc(from)}-${esc(to)}`))
    .join("");
}

/**
 * The database side of decision 6: trimmed, 1-100 code points, no control or
 * bidi override/isolate characters, and at least one visible character.
 */
function displayNameCheck(): RawBuilder<unknown> {
  const space = pgClass(WHITE_SPACE);
  const forbidden = pgClass(CONTROL_CHARACTERS, BIDI_OVERRIDES_AND_ISOLATES);
  const blank = pgClass(WHITE_SPACE, INVISIBLE_CHARACTERS);
  return sql`char_length(display_name) between 1 and ${sql.lit(DISPLAY_NAME_MAX_CODE_POINTS)}
    and display_name !~ ${sql.lit(`^[${space}]`)}
    and display_name !~ ${sql.lit(`[${space}]$`)}
    and display_name !~ ${sql.lit(`[${forbidden}]`)}
    and display_name ~ ${sql.lit(`[^${blank}]`)}`;
}

/**
 * People (family members, login optional) and users (logins: link and role
 * only; M1.3 adds the auth tables). Design note: docs/design/m1-2-data-model.md.
 * No date of birth, email or address on people (minimal data).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create function set_updated_at() returns trigger language plpgsql as $$
    begin
      new.updated_at := now();
      return new;
    end $$`.execute(db);

  // users before people: people's created_by/updated_by reference users.
  await db.schema
    .createTable("users")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("person_id", "uuid", (c) => c.unique())
    .addColumn("role", "text", (c) =>
      c
        .notNull()
        .defaultTo("member")
        .check(sql`role in ('admin', 'member')`),
    )
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await addUpdatedAtTrigger(db, "users");

  await withRecordColumns(db.schema.createTable("people"), { ownerRequired: false })
    .addColumn("display_name", "text", (c) =>
      c.notNull().check(displayNameCheck()),
    )
    .addColumn("relationship", "text", (c) => c.check(sql`char_length(relationship) <= 50`))
    .execute();
  await addUpdatedAtTrigger(db, "people");

  // A person linked to a login can't be deleted until the link is removed.
  await db.schema
    .alterTable("users")
    .addForeignKeyConstraint("users_person_id_fkey", ["person_id"], "people", ["id"], (fk) => fk.onDelete("restrict"))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // One statement: the two tables reference each other.
  await sql`drop table people, users`.execute(db);
  await sql`drop function set_updated_at()`.execute(db);
}
