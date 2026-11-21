import { sql } from "kysely";
import { kyselyOf, type DbLike } from "./handle.ts";

export type AuditRetentionResult = { deleted: number; ipPrefixesCleared: number; usersDeleted: number };

/**
 * Calls audit_log_retention() (migration 0003): deletes audit rows older than
 * 2 years, sets ip_prefix to null after 90 days, then deletes deactivated
 * users who have no audit rows left (decision 8). The only way rows leave the
 * append-only audit log. Run nightly by the worker.
 */
export async function runAuditRetention(db: DbLike): Promise<AuditRetentionResult> {
  const { rows } = await sql<{ deleted: string; ip_prefixes_cleared: string; users_deleted: string }>`
    select deleted, ip_prefixes_cleared, users_deleted from audit_log_retention()`.execute(kyselyOf(db));
  return {
    deleted: Number(rows[0]?.deleted ?? 0),
    ipPrefixesCleared: Number(rows[0]?.ip_prefixes_cleared ?? 0),
    usersDeleted: Number(rows[0]?.users_deleted ?? 0),
  };
}
