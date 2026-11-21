import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { Database } from "./schema.ts";

export type CreateDbOptions = { maxConnections?: number };

/** Small pool: 2–5 users, < 1 request/second (design note estimate). */
export function createDb(databaseUrl: string, options: CreateDbOptions = {}): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: options.maxConnections ?? 5,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
  });
  // An idle client losing its connection (e.g. Postgres restart) must not crash the process.
  pool.on("error", () => {});
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Resolves when Postgres answers `select 1`; rejects within ~3 s otherwise. */
export async function pingDatabase(db: Kysely<Database>): Promise<void> {
  await sql`select 1`.execute(db);
}
