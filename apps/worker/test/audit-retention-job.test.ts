import { describe, expect, it } from "vitest";
import { AUDIT_RETENTION_CRON, AUDIT_RETENTION_QUEUE, runAuditRetentionJob } from "../src/audit-retention-job.ts";

describe("audit retention job (M1.2)", () => {
  it("runs nightly on its own queue", () => {
    expect(AUDIT_RETENTION_QUEUE).toBe("audit-retention");
    expect(AUDIT_RETENTION_CRON).toBe("15 3 * * *"); // 03:15 UTC every day
  });

  it("calls the retention function and logs the counts only", async () => {
    const logged: Array<[string, Record<string, unknown>]> = [];
    await runAuditRetentionJob({
      retain: async () => ({ deleted: 3, ipPrefixesCleared: 7, usersDeleted: 1 }),
      log: (msg, fields) => logged.push([msg, fields]),
    });
    expect(logged).toEqual([["audit retention", { deleted: 3, ipPrefixesCleared: 7, usersDeleted: 1 }]]);
  });

  it("lets a failure reject so pg-boss retries the job", async () => {
    await expect(
      runAuditRetentionJob({ retain: async () => { throw new Error("db down"); }, log: () => {} }),
    ).rejects.toThrow("db down");
  });
});
