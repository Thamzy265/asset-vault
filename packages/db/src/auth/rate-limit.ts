import { createHmac } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "../schema.ts";

/**
 * Sign-in rate limits (design note M1.3, failure plan): 5 failed passwords per
 * account and 20 per IP prefix in any 15 minutes; then 429 with the time left.
 * Failures are kept in auth_sign_in_failures for the window only.
 *
 * - The account is the email as typed (trimmed, lower case), keyed-hashed with
 *   AUTH_ENCRYPTION_KEY: unknown emails are limited exactly like real ones, so
 *   the limit can't be used to tell which emails exist, and no email is stored.
 * - Without a trusted IP header every client shares one "unknown" prefix
 *   (behind Docker's port mapping all clients look the same anyway).
 */
export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_PER_ACCOUNT = 5;
export const MAX_PER_IP_PREFIX = 20;
const UNKNOWN_IP = "unknown";

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function accountKey(secret: string, email: string): string {
  return createHmac("sha256", secret).update(`sign-in:${normaliseEmail(email)}`).digest("base64url");
}

export function ipKey(prefix: string | null): string {
  return prefix ?? UNKNOWN_IP;
}

export type Limit = { limited: false } | { limited: true; retryAfterSeconds: number };

export async function checkSignInLimit(db: Kysely<Database>, account: string, ip: string): Promise<Limit> {
  const { rows } = await sql<{ scope: string; n: string; oldest: Date | null; nth: Date | null }>`
    with recent as (
      select account_key, ip_key, at from auth_sign_in_failures
      where at > now() - make_interval(secs => ${WINDOW_MS / 1000}) and (account_key = ${account} or ip_key = ${ip})
    )
    select 'account' as scope, count(*) as n,
      (select at from recent where account_key = ${account} order by at desc offset ${MAX_PER_ACCOUNT - 1} limit 1) as nth, null::timestamptz as oldest
      from recent where account_key = ${account}
    union all
    select 'ip', count(*), (select at from recent where ip_key = ${ip} order by at desc offset ${MAX_PER_IP_PREFIX - 1} limit 1), null
      from recent where ip_key = ${ip}`.execute(db);
  let retryAt = 0;
  for (const row of rows) {
    const max = row.scope === "account" ? MAX_PER_ACCOUNT : MAX_PER_IP_PREFIX;
    // Limited until the failure that filled the budget leaves the window.
    if (Number(row.n) >= max && row.nth) retryAt = Math.max(retryAt, new Date(row.nth).getTime() + WINDOW_MS);
  }
  if (retryAt === 0) return { limited: false };
  return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)) };
}

/**
 * Counts a sign-in attempt BEFORE its password is checked, atomically (reviewer S1: with check and
 * record apart, 30 parallel wrong passwords all got through). Under per-account and per-network
 * advisory locks, held only for this short transaction (not for the password hash), it either
 * refuses (the budget is spent) or inserts the attempt as a failure. The caller removes the row
 * with releaseSignInAttempt when the password turns out right, so only wrong passwords stay counted.
 * Failures that left the window are dropped here.
 */
export async function claimSignInAttempt(db: Kysely<Database>, account: string, ip: string): Promise<{ limited: false; id: string } | { limited: true; retryAfterSeconds: number }> {
  return db.transaction().execute(async (trx) => {
    // Always the same order (sorted), so two attempts can never wait for each other.
    for (const key of [`sign-in-account:${account}`, `sign-in-ip:${ip}`].sort()) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
    }
    await trx.deleteFrom("auth_sign_in_failures").where(sql<boolean>`at < now() - make_interval(secs => ${WINDOW_MS / 1000})`).execute();
    const limit = await checkSignInLimit(trx, account, ip);
    if (limit.limited) return limit;
    const row = await trx.insertInto("auth_sign_in_failures").values({ account_key: account, ip_key: ip }).returning("id").executeTakeFirstOrThrow();
    return { limited: false as const, id: String(row.id) };
  });
}

/** The password was right: the attempt claimed above is not a failure. */
export async function releaseSignInAttempt(db: Kysely<Database>, id: string): Promise<void> {
  await db.deleteFrom("auth_sign_in_failures").where("id", "=", id as never).execute();
}

/** The 429 copy (UI spec): "Too many tries. Try again in N minutes." */
export function retryMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many tries. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}
