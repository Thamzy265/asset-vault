// The migrations entry point (design note M1.2, decision 9). Used only by the
// migrate CLI (cli.ts) and by tests through test/support/migrate.ts. It is not
// exported from index.ts, so apps can't run or revert migrations; the ESLint
// rule in eslint.config.mjs stops apps importing packages/db/src paths.
import { Migrator, type MigrationResultSet } from "kysely/migration";
import { kyselyOf, type DbLike } from "./handle.ts";
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
