import { sql, type Kysely } from "kysely";
import { APP_ROLE } from "./record-columns.ts";

/**
 * M1.3 item (g), from M1.2 QA: users are deactivated, not deleted (design note
 * M1.2, decision 8). Only audit_log_retention(), which runs as its owner
 * (SECURITY DEFINER), deletes a deactivated user once their last audit row has
 * expired. The app role keeps SELECT, INSERT and UPDATE on users.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`revoke delete on users from ${sql.id(APP_ROLE)}`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`grant delete on users to ${sql.id(APP_ROLE)}`.execute(db);
}
