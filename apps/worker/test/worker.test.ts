import { DatabaseUnavailableError, closeDatabase, openDatabase, readHeartbeat } from "@vault/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../packages/db/test/support/fresh-database.ts";
import { rawQuery } from "../../../packages/db/test/support/raw-sql.ts";
import { AUDIT_RETENTION_CRON, AUDIT_RETENTION_QUEUE } from "../src/audit-retention-job.ts";
import { HEARTBEAT_QUEUE } from "../src/heartbeat-job.ts";
import { startWorker, type RunningWorker } from "../src/worker.ts";

describe("startWorker (real Postgres)", () => {
  let url: string;
  let drop: () => Promise<void>;
  let worker: RunningWorker | undefined;

  beforeAll(async () => {
    ({ url, drop } = await freshDatabase());
  });

  afterAll(async () => {
    await worker?.stop();
    await drop?.();
  });

  it("schedules the heartbeat and records it when the job runs", async () => {
    worker = await startWorker({ databaseUrl: url });

    const schedules = await worker.boss.getSchedules(HEARTBEAT_QUEUE);
    expect(schedules.map((s) => s.cron)).toEqual(["* * * * *"]);

    // Run the job now rather than waiting for the next minute.
    await worker.boss.send(HEARTBEAT_QUEUE);
    const db = openDatabase(url);
    try {
      await expect.poll(() => readHeartbeat(db), { timeout: 15_000, interval: 250 }).not.toBeNull();
    } finally {
      await closeDatabase(db);
    }
  });

  it("schedules audit retention nightly and runs the retention function when the job runs", async () => {
    expect(worker).toBeDefined();
    const schedules = await worker!.boss.getSchedules(AUDIT_RETENTION_QUEUE);
    expect(schedules.map((s) => s.cron)).toEqual([AUDIT_RETENTION_CRON]);

    await rawQuery(url, "insert into audit_log (action, at) values ('sign_out', now() - interval '3 years')");
    await worker!.boss.send(AUDIT_RETENTION_QUEUE);
    const expired = async () =>
      (await rawQuery<{ n: number }>(url, "select count(*)::int as n from audit_log where at < now() - interval '2 years'"))[0]?.n;
    await expect.poll(expired, { timeout: 15_000, interval: 250 }).toBe(0);
  });

  it("gives up with DatabaseUnavailableError when Postgres never answers", async () => {
    await expect(
      startWorker({
        databaseUrl: "postgres://127.0.0.1:1/unreachable",
        wait: { timeoutMs: 1_500, initialDelayMs: 100 },
      }),
    ).rejects.toBeInstanceOf(DatabaseUnavailableError);
  });
});
