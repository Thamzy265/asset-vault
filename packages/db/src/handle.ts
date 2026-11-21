import { Kysely } from "kysely";
import { createDb, type CreateDbOptions } from "./client.ts";
import type { Database } from "./schema.ts";

/**
 * What apps hold instead of a database client: an opaque token with no query
 * methods. Only functions inside packages/db can turn it back into the client,
 * so every app read and write goes through this package's functions and
 * repositories (and their visibility check). The ESLint rule in
 * eslint.config.mjs stops apps importing kysely, pg or packages/db/src paths.
 */
export type DbHandle = { readonly kind: "vault-db" };

/**
 * Handle -> client. Kept on globalThis under a registered symbol (review L7):
 * `next dev` re-evaluates this module on reload, and the web app keeps its
 * handle across reloads (apps/web/src/server/db.ts), so a module-local map
 * would stop resolving it. Not enumerable; apps may not use Symbol.for (lint),
 * and the database roles stay the backstop.
 */
const CLIENTS_KEY = Symbol.for("@vault/db/clients");
type ClientMap = WeakMap<DbHandle, Kysely<Database>>;
const store = globalThis as typeof globalThis & { [CLIENTS_KEY]?: ClientMap };
if (!store[CLIENTS_KEY]) {
  Object.defineProperty(store, CLIENTS_KEY, { value: new WeakMap(), enumerable: false, writable: false, configurable: false });
}
const clients: ClientMap = store[CLIENTS_KEY]!;

/** A handle, or (inside packages/db and its tests) the client itself. */
export type DbLike = DbHandle | Kysely<Database>;

export function openDatabase(databaseUrl: string, options: CreateDbOptions = {}): DbHandle {
  const handle: DbHandle = Object.freeze({ kind: "vault-db" });
  clients.set(handle, createDb(databaseUrl, options));
  return handle;
}

export async function closeDatabase(db: DbLike): Promise<void> {
  await kyselyOf(db).destroy();
}

/** Internal to packages/db: never exported from index.ts. */
export function kyselyOf(db: DbLike): Kysely<Database> {
  if (db instanceof Kysely) return db;
  const client = clients.get(db);
  if (!client) throw new TypeError("Not a database handle from openDatabase()");
  return client;
}
