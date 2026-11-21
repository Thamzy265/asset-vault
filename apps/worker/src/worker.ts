import { closeDatabase, log, migrateUp, openDatabase, recordHeartbeat, runAuditRetention, waitForDatabaseReady, type WaitOptions } from "@vault/db";
import { PgBoss } from "pg-boss";
import { AUDIT_RETENTION_CRON, AUDIT_RETENTION_QUEUE, runAuditRetentionJob } from "./audit-retention-job.ts";
import { HEARTBEAT_CRON, HEARTBEAT_QUEUE, runHeartbeat } from "./heartbeat-job.ts";

export type WorkerOptions = {
  databaseUrl: string;
  /** Override start-up retry timing (tests only); defaults to ~60 s. */
  wait?: Pick<WaitOptions, "timeoutMs" | "initialDelayMs">;
};

export type RunningWorker = {
  boss: PgBoss;
  stop: () => Promise<void>;
};

/**
 * Waits for Postgres (backoff, ~60 s), applies pending migrations, starts
 * pg-boss and schedules the heartbeat and the nightly audit retention.
 * Throws DatabaseUnavailableError if
 * Postgres never answers, or at once if it refuses the credentials or
 * database name, so main() can exit non-zero.
 */
export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  const db = openDatabase(options.databaseUrl, { maxConnections: 2 });
  try {
    await waitForDatabaseReady(db, options.wait);
    const applied = await migrateUp(db);
    log("info", "migrations applied", { migrations: applied });
  } catch (error) {
    await closeDatabase(db);
    throw error;
  }

  const boss = new PgBoss({ connectionString: options.databaseUrl, max: 3 });
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
  log("info", "worker started", { queues: [HEARTBEAT_QUEUE, AUDIT_RETENTION_QUEUE] });

  return {
    boss,
    stop: async () => {
      await boss.stop({ graceful: true, timeout: 10_000 });
      await closeDatabase(db);
    },
  };
}
