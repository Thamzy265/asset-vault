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

const clients = new WeakMap<DbHandle, Kysely<Database>>();

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
