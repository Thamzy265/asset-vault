import { sql, type Kysely } from "kysely";
import { addUpdatedAtTrigger, withRecordColumns } from "./record-columns.ts";

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
      c.notNull().check(sql`char_length(display_name) between 1 and 100 and btrim(display_name) <> ''`),
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
