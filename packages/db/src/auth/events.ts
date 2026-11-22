import type { Kysely } from "kysely";
import type { LogFn } from "../access.ts";
import { errorCode } from "../log.ts";
import type { AuditAction, Database } from "../schema.ts";

export type AuthEvent = Extract<
  AuditAction,
  "sign_in" | "sign_in_failed" | "sign_out" | "2fa_enrolled" | "2fa_failed" | "password_changed" | "backup_code_used"
>;

/** The events that may carry an ip_prefix (M1.2 decision 4). */
const WITH_IP: ReadonlySet<AuthEvent> = new Set(["sign_in", "sign_in_failed", "2fa_failed", "backup_code_used"]);

/**
 * Writes an auth event to the audit log: who (when known), what, and for the
 * four sign-in-attempt events the IP prefix. Never a value: no email, code or
 * token. Best effort, like view rows: a failed write is logged (code only)
 * and never blocks a sign-in or sign-out.
 */
export async function auditAuthEvent(
  db: Kysely<Database>,
  log: LogFn,
  action: AuthEvent,
  userId: string | null,
  ipPrefix: string | null,
): Promise<void> {
  try {
    await db
      .insertInto("audit_log")
      .values({ action, actor_user_id: userId, ip_prefix: WITH_IP.has(action) ? ipPrefix : null })
      .execute();
  } catch (error) {
    const code = errorCode(error);
    log("error", "audit auth event write failed", { action, ...(code && { code }) });
  }
}
