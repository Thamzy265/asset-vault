import { sql, type CreateTableBuilder, type Kysely } from "kysely";

/**
 * Shared migration helper (M1.2 design note): the common record columns that
 * every business table carries, plus its updated_at trigger. A migration that
 * adds a business table uses both:
 *
 *   await withRecordColumns(db.schema.createTable("assets"), { ownerRequired: true })
 *     .addColumn("name", "text", (c) => c.notNull())
 *     .execute();
 *   await addUpdatedAtTrigger(db, "assets");
 *
 * and its `down` drops the table (the trigger goes with it). Needs the
 * `people` and `users` tables and the `set_updated_at()` function from 0002.
 */
export type RecordColumn =
  | "id"
  | "owner_person_id"
  | "visibility"
  | "created_at"
  | "updated_at"
  | "created_by_user_id"
  | "updated_by_user_id";

export type RecordColumnsOptions = {
  /** Whether the record must have an owner. Only `people` itself may have none. */
  ownerRequired: boolean;
};

export const VISIBILITIES = ["family", "private"] as const;

export function withRecordColumns<TB extends string, C extends string>(
  table: CreateTableBuilder<TB, C>,
  options: RecordColumnsOptions,
): CreateTableBuilder<TB, C | RecordColumn> {
  return table
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("owner_person_id", "uuid", (c) => {
      const owner = c.references("people.id").onDelete("restrict");
      return options.ownerRequired ? owner.notNull() : owner;
    })
    .addColumn("visibility", "text", (c) =>
      c
        .notNull()
        .defaultTo("family")
        .check(sql`visibility in ('family', 'private')`),
    )
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("created_by_user_id", "uuid", (c) => c.references("users.id").onDelete("set null"))
    .addColumn("updated_by_user_id", "uuid", (c) => c.references("users.id").onDelete("set null"));
}

/** Sets `updated_at = now()` on every UPDATE of `table`. Dropped with the table. */
export async function addUpdatedAtTrigger(db: Kysely<unknown>, table: string): Promise<void> {
  await sql`
    create trigger ${sql.id(`${table}_set_updated_at`)}
    before update on ${sql.table(table)}
    for each row execute function set_updated_at()`.execute(db);
}
