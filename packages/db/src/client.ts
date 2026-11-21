import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { Database } from "./schema.ts";

export type CreateDbOptions = { maxConnections?: number };

/**
 * Normal pool (review N1): Postgres cancels a statement (statement_timeout)
 * before the client gives up on it (query_timeout), so the connection is freed
 * instead of staying busy behind a query nobody waits for. query_timeout
 * remains for when Postgres stops answering on an open connection (paused, or
 * the network path dropped): without it a pooled query waits forever.
 */
export const POOL_TIMEOUTS = { statementMs: 4_000, queryMs: 5_000 } as const;

/**
 * Migration connection (review L7): long statements are allowed, a lock wait
 * is not (a migration stuck behind a lock fails in 10 s instead of blocking
 * every query queued behind it), and the client waits longer than Postgres.
 */
export const MIGRATION_TIMEOUTS = { statementMs: 300_000, lockMs: 10_000, queryMs: 330_000 } as const;

type PoolSettings = {
  max: number;
  statementMs: number;
  queryMs: number;
  lockMs?: number;
};

function pool(databaseUrl: string, settings: PoolSettings): Kysely<Database> {
  const p = new pg.Pool({
    connectionString: databaseUrl,
    max: settings.max,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: settings.statementMs,
    query_timeout: settings.queryMs,
    ...(settings.lockMs !== undefined && { lock_timeout: settings.lockMs }),
    keepAlive: true,
  });
  // An idle client losing its connection (e.g. Postgres restart) must not crash the process.
  p.on("error", () => {});
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: p }) });
}

/** Small pool: 2–5 users, < 1 request/second (design note estimate). */
export function createDb(databaseUrl: string, options: CreateDbOptions = {}): Kysely<Database> {
  return pool(databaseUrl, { max: options.maxConnections ?? 5, ...POOL_TIMEOUTS });
}

/** One connection with the migration limits. Used by the migrate CLI only. */
export function createMigrationDb(databaseUrl: string): Kysely<Database> {
  return pool(databaseUrl, { max: 1, ...MIGRATION_TIMEOUTS });
}

/**
 * Resolves when Postgres answers `select 1`. Rejects within ~3 s when a new
 * connection can't be opened, and within ~5 s when an open one stops answering.
 */
export async function pingDatabase(db: Kysely<Database>): Promise<void> {
  await sql`select 1`.execute(db);
}
