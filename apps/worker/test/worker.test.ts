import { DatabaseUnavailableError, closeDatabase, openDatabase, readHeartbeat } from "@vault/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../packages/db/test/support/fresh-database.ts";
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

  it("migrates, schedules the heartbeat and records it when the job runs", async () => {
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

  it("gives up with DatabaseUnavailableError when Postgres never answers", async () => {
    await expect(
      startWorker({
        databaseUrl: "postgres://127.0.0.1:1/unreachable",
        wait: { timeoutMs: 1_500, initialDelayMs: 100 },
      }),
    ).rejects.toBeInstanceOf(DatabaseUnavailableError);
  });
});
