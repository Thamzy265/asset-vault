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
    // Client-side limit: statement_timeout is enforced by Postgres, so it can't
    // help when Postgres stops answering on an open connection (paused, or the
    // network path dropped). Without this a pooled query waits forever.
    query_timeout: 5_000,
    keepAlive: true,
  });
  // An idle client losing its connection (e.g. Postgres restart) must not crash the process.
  pool.on("error", () => {});
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Resolves when Postgres answers `select 1`. Rejects within ~3 s when a new
 * connection can't be opened, and within ~5 s when an open one stops answering.
 */
export async function pingDatabase(db: Kysely<Database>): Promise<void> {
  await sql`select 1`.execute(db);
}
