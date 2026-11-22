// Test-only access to the migrations entry point (decision 9). App tests may
// import packages/db/test/support/*, never packages/db/src (eslint.config.mjs).
export { migrateDown, migrateUp } from "../../src/migrate.ts";
export { migrations } from "../../src/migrations/index.ts";

import { Migrator } from "kysely/migration";
import { kyselyOf, type DbLike } from "../../src/handle.ts";
import { migrations as allMigrations } from "../../src/migrations/index.ts";

/**
 * Applies (or reverts) migrations until `name` is the last one applied. For tests
 * that check an older migration's own up/down as it was when it shipped, so a
 * newer migration doesn't change what they see.
 */
export async function migrateTo(db: DbLike, name: string): Promise<void> {
  if (!(name in allMigrations)) throw new Error(`Unknown migration ${name}`);
  const result = await new Migrator({ db: kyselyOf(db), provider: { getMigrations: async () => allMigrations } }).migrateTo(name);
  if (result.error) throw result.error;
}
