import { sql } from "kysely";
import { kyselyOf, type DbLike } from "../handle.ts";
import { SESSION_ABSOLUTE_MS } from "./options.ts";
import { WINDOW_MS } from "./rate-limit.ts";

export type AuthCleanupResult = { sessions: number; setupTokens: number; verifications: number; signInFailures: number };

/**
 * Deletes what has outlived its purpose (design note M1.3, Privacy): sessions
 * past their idle expiry or 7 days old, expired setup links and sign-in
 * challenges, and failed attempts older than the 15-minute rate-limit window.
 * Run by the worker every 15 minutes, as vault_app.
 */
export async function deleteExpiredAuthRows(handle: DbLike): Promise<AuthCleanupResult> {
  const db = kyselyOf(handle);
  const count = (r: { numDeletedRows: bigint }) => Number(r.numDeletedRows);
  const sessions = await db
    .deleteFrom("auth_sessions")
    .where((eb) => eb.or([eb("expires_at", "<=", sql<Date>`now()`), eb("created_at", "<=", sql<Date>`now() - make_interval(secs => ${SESSION_ABSOLUTE_MS / 1000})`)]))
    .executeTakeFirst();
  const setupTokens = await db.deleteFrom("auth_setup_tokens").where("expires_at", "<=", sql<Date>`now()`).executeTakeFirst();
  const verifications = await db.deleteFrom("auth_verifications").where("expires_at", "<=", sql<Date>`now()`).executeTakeFirst();
  const signInFailures = await db
    .deleteFrom("auth_sign_in_failures")
    .where("at", "<", sql<Date>`now() - make_interval(secs => ${WINDOW_MS / 1000})`)
    .executeTakeFirst();
  return { sessions: count(sessions), setupTokens: count(setupTokens), verifications: count(verifications), signInFailures: count(signInFailures) };
}
