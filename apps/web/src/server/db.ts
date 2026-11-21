import { loadDbConfig, openDatabase, type DbHandle } from "@vault/db";

/**
 * One pool per server bundle. Next bundles the proxy, the pages and the routes
 * separately, each with its own copy of @vault/db, and in production a handle
 * resolves only in the copy that opened it (handle.ts, review N1). So the
 * handle is kept per module, except in development and test, where it lives on
 * globalThis to survive `next dev` reloads (review L7; there @vault/db shares
 * its client map too).
 */
const shared = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
const globalForDb = globalThis as unknown as { vaultDb?: DbHandle };
let local: DbHandle | undefined;

export function getDb(): DbHandle {
  if (shared) {
    globalForDb.vaultDb ??= openDatabase(loadDbConfig(process.env).databaseUrl);
    return globalForDb.vaultDb;
  }
  local ??= openDatabase(loadDbConfig(process.env).databaseUrl);
  return local;
}
