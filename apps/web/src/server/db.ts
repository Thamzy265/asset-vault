import { loadDbConfig, openDatabase, type DbHandle } from "@vault/db";

const globalForDb = globalThis as unknown as { vaultDb?: DbHandle };

/** One pool per server process (reused across dev hot reloads). */
export function getDb(): DbHandle {
  globalForDb.vaultDb ??= openDatabase(loadDbConfig(process.env).databaseUrl);
  return globalForDb.vaultDb;
}
