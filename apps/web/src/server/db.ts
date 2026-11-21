import { createDb, loadDbConfig, type Db } from "@vault/db";

const globalForDb = globalThis as unknown as { vaultDb?: Db };

/** One pool per server process (reused across dev hot reloads). */
export function getDb(): Db {
  globalForDb.vaultDb ??= createDb(loadDbConfig(process.env).databaseUrl);
  return globalForDb.vaultDb;
}
