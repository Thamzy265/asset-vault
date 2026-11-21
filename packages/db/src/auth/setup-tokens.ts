import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../schema.ts";

/** Setup links (design note M1.3): single use, valid 24 h, only the hash stored. */
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

/** Uses the token up (deletes it) and returns its user, or null if it was not valid. */
export async function consumeSetupToken(trx: Transaction<Database>, token: string): Promise<string | null> {
  if (!isPlausibleToken(token)) return null;
  const row = await trx
    .deleteFrom("auth_setup_tokens")
    .where("token_hash", "=", hashSetupToken(token))
    .where("expires_at", ">", sql<Date>`now()`)
    .returning("user_id")
    .executeTakeFirst();
  return row?.user_id ?? null;
}

function isPlausibleToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
