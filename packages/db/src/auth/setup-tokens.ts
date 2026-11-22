import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../schema.ts";

/** Setup links (design note M1.3): valid 24 h from issue and until 2FA enrolment is confirmed, only the hash stored. */
export const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function hashSetupToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Issues a new link for the user and revokes any earlier one (re-issuing revokes the old link). */
export async function issueSetupToken(trx: Transaction<Database>, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  await trx.deleteFrom("auth_setup_tokens").where("user_id", "=", userId).execute();
  const row = await trx
    .insertInto("auth_setup_tokens")
    .values({ user_id: userId, token_hash: hashSetupToken(token), expires_at: sql<Date>`now() + interval '24 hours'` })
    .returning("expires_at")
    .executeTakeFirstOrThrow();
  return { token, expiresAt: row.expires_at };
}

/** The user a valid (unexpired) token belongs to, without using it up. */
export async function peekSetupToken(db: Kysely<Database>, token: string): Promise<string | null> {
  if (!isPlausibleToken(token)) return null;
  const row = await db
    .selectFrom("auth_setup_tokens")
    .select("user_id")
    .where("token_hash", "=", hashSetupToken(token))
    .where("expires_at", ">", sql<Date>`now()`)
    .executeTakeFirst();
  return row?.user_id ?? null;
}

/** One lock per user for the whole setup (password, resume, confirm), held until the transaction ends. */
export async function lockSetupUser(trx: Transaction<Database>, userId: string): Promise<void> {
  // An advisory lock rather than FOR UPDATE: vault_app has no UPDATE grant on the token table (it is only added to and deleted from).
  await sql`select pg_advisory_xact_lock(hashtextextended(${`setup-user:${userId}`}, 0))`.execute(trx);
}

/**
 * The user a valid token belongs to, with that user's setup lock held until the transaction ends, so
 * the password, resume and confirm steps take turns (lead decision 5, reviewer S2). The token is read
 * again after the lock is won: a confirm that held it may have used the link up meanwhile.
 */
export async function lockSetupToken(trx: Transaction<Database>, token: string): Promise<string | null> {
  if (!isPlausibleToken(token)) return null;
  const hash = hashSetupToken(token);
  const find = () =>
    trx.selectFrom("auth_setup_tokens").select("user_id").where("token_hash", "=", hash).where("expires_at", ">", sql<Date>`now()`).executeTakeFirst();
  const first = await find();
  if (!first) return null;
  await lockSetupUser(trx, first.user_id);
  return (await find())?.user_id ?? null;
}

/** Uses the user's link up: called when 2FA enrolment is confirmed, not at the password step. */
export async function deleteSetupTokens(db: Kysely<Database>, userId: string): Promise<void> {
  await db.deleteFrom("auth_setup_tokens").where("user_id", "=", userId).execute();
}

function isPlausibleToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
