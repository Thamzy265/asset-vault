import type { Kysely } from "kysely";
import { Migrator, type MigrationResultSet } from "kysely/migration";
import { migrations } from "./migrations/index.ts";
import type { Database } from "./schema.ts";

function migrator(db: Kysely<Database>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  });
}

function unwrap(result: MigrationResultSet): string[] {
  if (result.error) throw result.error;
  return (result.results ?? []).map((r) => r.migrationName);
}

/** Applies every pending migration. Returns the names applied. */
export async function migrateUp(db: Kysely<Database>): Promise<string[]> {
  return unwrap(await migrator(db).migrateToLatest());
}

/** Reverts the most recent migration. Returns the name reverted (empty if none). */
export async function migrateDown(db: Kysely<Database>): Promise<string[]> {
  return unwrap(await migrator(db).migrateDown());
}
