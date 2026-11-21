import type { Kysely } from "kysely";
import type { Database } from "./schema.ts";

const HEARTBEAT_KEY = "worker.heartbeat";
const UNDEFINED_TABLE = "42P01";

export async function recordHeartbeat(db: Kysely<Database>, at: Date): Promise<void> {
  await db
    .insertInto("_meta")
    .values({ key: HEARTBEAT_KEY, value: at.toISOString(), updated_at: at })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value: at.toISOString(), updated_at: at }))
    .execute();
}

/** Last worker heartbeat, or null if none yet (including before the first migration). */
export async function readHeartbeat(db: Kysely<Database>): Promise<Date | null> {
  try {
    const row = await db
      .selectFrom("_meta")
      .select("updated_at")
      .where("key", "=", HEARTBEAT_KEY)
      .executeTakeFirst();
    return row?.updated_at ?? null;
  } catch (error) {
    if ((error as { code?: string }).code === UNDEFINED_TABLE) return null;
    throw error;
  }
}
