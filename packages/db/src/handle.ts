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
 * Handle -> client.
 * - By default (review N1): module-private. A symbol key on globalThis can
 *   always be listed (Object.getOwnPropertySymbols, Reflect.ownKeys), and the
 *   map would hand out the raw client, so production keeps none.
 * - Development and test only (review L7): kept on globalThis under a
 *   registered symbol, because `next dev` re-evaluates this module on reload
 *   while the web app keeps its handle (apps/web/src/server/db.ts).
 * Fail safe (M1.3 item f): any other NODE_ENV, including unset or a typo,
 * keeps the map private. The web and worker images set NODE_ENV=production.
 */
type ClientMap = WeakMap<DbHandle, Kysely<Database>>;
const SHARED_MAP_ENVS: ReadonlySet<string | undefined> = new Set(["development", "test"]);
function clientMap(): ClientMap {
  if (!SHARED_MAP_ENVS.has(process.env.NODE_ENV)) return new WeakMap();
  const key = Symbol.for("@vault/db/clients");
  const store = globalThis as typeof globalThis & { [key: symbol]: ClientMap | undefined };
  if (!store[key]) {
    Object.defineProperty(store, key, { value: new WeakMap(), enumerable: false, writable: false, configurable: false });
  }
  return store[key]!;
}
const clients: ClientMap = clientMap();

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
