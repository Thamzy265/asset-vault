import { describe, expect, it } from "vitest";
import { HEARTBEAT_CRON, HEARTBEAT_QUEUE, runHeartbeat } from "../src/heartbeat-job.ts";

describe("heartbeat job", () => {
  it("is scheduled every minute on its own queue", () => {
    expect(HEARTBEAT_QUEUE).toBe("heartbeat");
    expect(HEARTBEAT_CRON).toBe("* * * * *");
  });

  it("records the current time and logs it", async () => {
    const recorded: Date[] = [];
    const logged: Array<[string, Record<string, unknown>]> = [];
    const at = new Date("2026-11-21T10:00:00.000Z");
    await runHeartbeat({
      record: async (time) => { recorded.push(time); },
      now: () => at,
      log: (msg, fields) => logged.push([msg, fields]),
    });
    expect(recorded).toEqual([at]);
    expect(logged).toEqual([["heartbeat", { at: "2026-11-21T10:00:00.000Z" }]]);
  });

  it("lets a failed write reject so pg-boss retries the job", async () => {
    await expect(
      runHeartbeat({ record: async () => { throw new Error("db down"); }, now: () => new Date(), log: () => {} }),
    ).rejects.toThrow("db down");
  });
});
