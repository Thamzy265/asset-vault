import type { AuditRetentionResult } from "@vault/db";

export const AUDIT_RETENTION_QUEUE = "audit-retention";
/** Nightly at 03:15 UTC (pg-boss schedules in UTC). */
export const AUDIT_RETENTION_CRON = "15 3 * * *";

export type AuditRetentionDeps = {
  /** Deletes audit rows older than 2 years and clears ip_prefix after 90 days. */
  retain: () => Promise<AuditRetentionResult>;
  log: (msg: string, fields: Record<string, unknown>) => void;
};

/** Runs the retention function and logs the counts. A failure rejects so pg-boss retries the job. */
export async function runAuditRetentionJob(deps: AuditRetentionDeps): Promise<void> {
  const result = await deps.retain();
  deps.log("audit retention", { deleted: result.deleted, ipPrefixesCleared: result.ipPrefixesCleared });
}
