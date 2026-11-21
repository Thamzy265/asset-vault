import { kyselyOf, type DbLike } from "./handle.ts";
import { sql } from "kysely";
import { Migrator, type MigrationResultSet } from "kysely/migration";
import { migrations } from "./migrations/index.ts";

function migrator(db: DbLike): Migrator {
  return new Migrator({
    db: kyselyOf(db),
    provider: { getMigrations: async () => migrations },
  });
}

function unwrap(result: MigrationResultSet): string[] {
  if (result.error) throw result.error;
  return (result.results ?? []).map((r) => r.migrationName);
}

/** Applies every pending migration. Returns the names applied. */
export async function migrateUp(db: DbLike): Promise<string[]> {
  return unwrap(await migrator(db).migrateToLatest());
}

/** Reverts the most recent migration. Returns the name reverted (empty if none). */
export async function migrateDown(db: DbLike): Promise<string[]> {
  return unwrap(await migrator(db).migrateDown());
}

/** The schema version this code expects: the name of its last migration. */
export const EXPECTED_SCHEMA_VERSION: string = Object.keys(migrations).at(-1) ?? "";

const UNDEFINED_TABLE = "42P01";

/**
 * The schema version applied to the database: the name of the last migration
 * Kysely recorded, or null if none ran yet. Health compares it with
 * EXPECTED_SCHEMA_VERSION (review L7).
 */
export async function readSchemaVersion(db: DbLike): Promise<string | null> {
  try {
    const { rows } = await sql<{ name: string | null }>`select max(name) as name from kysely_migration`.execute(kyselyOf(db));
    return rows[0]?.name ?? null;
  } catch (error) {
    if ((error as { code?: string }).code === UNDEFINED_TABLE) return null;
    throw error;
  }
}
