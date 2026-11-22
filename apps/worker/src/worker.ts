import {
  closeDatabase,
  deleteExpiredAuthRows,
  log,
  openDatabase,
  recordHeartbeat,
  runAuditRetention,
  waitForDatabaseReady,
  type WaitOptions,
} from "@vault/db";
import { PgBoss, type ConstructorOptions } from "pg-boss";
import { AUDIT_RETENTION_CRON, AUDIT_RETENTION_QUEUE, runAuditRetentionJob } from "./audit-retention-job.ts";
import { AUTH_CLEANUP_CRON, AUTH_CLEANUP_QUEUE, runAuthCleanupJob } from "./auth-cleanup-job.ts";
import { HEARTBEAT_CRON, HEARTBEAT_QUEUE, runHeartbeat } from "./heartbeat-job.ts";

/**
 * pg-boss's own pool (review L4). pg-boss spreads its config into pg.Pool
 * (pg-boss 12, dist/db.js), so these reach every connection: query_timeout
 * stops a job fetch hanging on a connection that went silent, keepAlive
 * notices a dropped path, and statement_timeout stays below query_timeout so
 * Postgres cancels a slow statement first (design note M1.2, N1).
 */
export const BOSS_TIMEOUTS = { statementMs: 55_000, queryMs: 60_000, keepAlive: true } as const;

/** pg.Pool settings pg-boss passes through but does not declare. */
type BossConfig = ConstructorOptions & { statement_timeout: number; query_timeout: number; keepAlive: boolean };

export type WorkerOptions = {
  databaseUrl: string;
  /** Override start-up retry timing (tests only); defaults to ~60 s. */
  wait?: Pick<WaitOptions, "timeoutMs" | "initialDelayMs">;
  /** Override the pg-boss pool limits (tests only); defaults to BOSS_TIMEOUTS. */
  bossTimeouts?: { statementMs: number; queryMs: number };
};

export type RunningWorker = {
  boss: PgBoss;
  stop: () => Promise<void>;
};

/**
 * Waits for Postgres (backoff, ~60 s), starts pg-boss and schedules the
 * heartbeat, the nightly audit retention and the auth cleanup (every 15 min). It does not migrate: the one-shot
 * `migrate` Compose service does, before the worker starts (review L7).
 * Throws DatabaseUnavailableError if Postgres never answers, or at once if it
 * refuses the credentials or database name, so main() can exit non-zero.
 */
export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  const db = openDatabase(options.databaseUrl, { maxConnections: 2 });
  try {
    await waitForDatabaseReady(db, options.wait);
  } catch (error) {
    await closeDatabase(db);
    throw error;
  }

  // The pgboss schema comes from migration 0004: the app role may create pg-boss's tables
  // in it but can't create schemas (design note M1.2, decision 3).
  const timeouts = options.bossTimeouts ?? BOSS_TIMEOUTS;
  const config: BossConfig = {
    connectionString: options.databaseUrl,
    max: 3,
    createSchema: false,
    statement_timeout: timeouts.statementMs,
    query_timeout: timeouts.queryMs,
    keepAlive: BOSS_TIMEOUTS.keepAlive,
  };
  const boss = new PgBoss(config);
  boss.on("error", (error) => log("error", "pg-boss error", { error: error.message }));
  await boss.start();
  await boss.createQueue(HEARTBEAT_QUEUE);
  await boss.schedule(HEARTBEAT_QUEUE, HEARTBEAT_CRON);
  await boss.work(HEARTBEAT_QUEUE, async () => {
    await runHeartbeat({
      record: (at) => recordHeartbeat(db, at),
      now: () => new Date(),
      log: (msg, fields) => log("info", msg, fields),
    });
  });
  await boss.createQueue(AUDIT_RETENTION_QUEUE);
  await boss.schedule(AUDIT_RETENTION_QUEUE, AUDIT_RETENTION_CRON);
  await boss.work(AUDIT_RETENTION_QUEUE, async () => {
    await runAuditRetentionJob({
      retain: () => runAuditRetention(db),
      log: (msg, fields) => log("info", msg, fields),
    });
  });
  await boss.createQueue(AUTH_CLEANUP_QUEUE);
  await boss.schedule(AUTH_CLEANUP_QUEUE, AUTH_CLEANUP_CRON);
  await boss.work(AUTH_CLEANUP_QUEUE, async () => {
    await runAuthCleanupJob({
      clean: () => deleteExpiredAuthRows(db),
      log: (msg, fields) => log("info", msg, fields),
    });
  });
  log("info", "worker started", { queues: [HEARTBEAT_QUEUE, AUDIT_RETENTION_QUEUE, AUTH_CLEANUP_QUEUE] });

  return {
    boss,
    stop: async () => {
      await boss.stop({ graceful: true, timeout: 10_000 });
      await closeDatabase(db);
    },
  };
}
