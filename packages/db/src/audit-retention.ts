import { sql } from "kysely";
import { kyselyOf, type DbLike } from "./handle.ts";

export type AuditRetentionResult = { deleted: number; ipPrefixesCleared: number };

/**
 * Calls audit_log_retention() (migration 0003): deletes audit rows older than
 * 2 years and sets ip_prefix to null after 90 days. The only way rows leave
 * the append-only audit log. Run nightly by the worker.
 */
export async function runAuditRetention(db: DbLike): Promise<AuditRetentionResult> {
  const { rows } = await sql<{ deleted: string; ip_prefixes_cleared: string }>`
    select deleted, ip_prefixes_cleared from audit_log_retention()`.execute(kyselyOf(db));
  return { deleted: Number(rows[0]?.deleted ?? 0), ipPrefixesCleared: Number(rows[0]?.ip_prefixes_cleared ?? 0) };
}
