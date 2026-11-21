import type { AuthCleanupResult } from "@vault/db";

export const AUTH_CLEANUP_QUEUE = "auth-cleanup";
/** Every 15 minutes: sessions last at most 7 days, failed attempts 15 minutes (M1.3). */
export const AUTH_CLEANUP_CRON = "*/15 * * * *";

export type AuthCleanupDeps = {
  /** Deletes expired sessions, setup links, sign-in challenges and old failed attempts. */
  clean: () => Promise<AuthCleanupResult>;
  log: (msg: string, fields: Record<string, unknown>) => void;
};

/** Runs the cleanup and logs the counts. A failure rejects so pg-boss retries the job. */
export async function runAuthCleanupJob(deps: AuthCleanupDeps): Promise<void> {
  const result = await deps.clean();
  deps.log("auth cleanup", { ...result });
}
