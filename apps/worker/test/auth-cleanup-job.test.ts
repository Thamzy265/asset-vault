import { describe, expect, it } from "vitest";
import { AUTH_CLEANUP_CRON, AUTH_CLEANUP_QUEUE, runAuthCleanupJob } from "../src/auth-cleanup-job.ts";

describe("auth cleanup job (M1.3)", () => {
  it("runs every 15 minutes on its own queue", () => {
    expect(AUTH_CLEANUP_QUEUE).toBe("auth-cleanup");
    expect(AUTH_CLEANUP_CRON).toBe("*/15 * * * *");
  });

  it("deletes expired auth rows and logs the counts only", async () => {
    const logged: Array<[string, Record<string, unknown>]> = [];
    await runAuthCleanupJob({
      clean: async () => ({ sessions: 2, setupTokens: 1, verifications: 3, signInFailures: 4 }),
      log: (msg, fields) => logged.push([msg, fields]),
    });
    expect(logged).toEqual([["auth cleanup", { sessions: 2, setupTokens: 1, verifications: 3, signInFailures: 4 }]]);
  });

  it("lets a failure reject so pg-boss retries the job", async () => {
    await expect(runAuthCleanupJob({ clean: async () => { throw new Error("db down"); }, log: () => {} })).rejects.toThrow("db down");
  });
});
