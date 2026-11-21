import { sql, type Kysely } from "kysely";
import { APP_ROLE, grantAppAccess } from "./record-columns.ts";

/**
 * What the app role may do (design note M1.2, decision 3). The roles and
 * their passwords come from the Postgres init script
 * (packages/db/initdb/10-vault-roles.sh); this migration runs as
 * vault_migrator, which owns everything it grants on.
 *
 * - Business tables: SELECT, INSERT, UPDATE, DELETE.
 * - audit_log: SELECT, and INSERT on the columns the app may set only (not
 *   `id`, not `at`, so time can't be backdated). Rows leave the log only
 *   through audit_log_retention(), which the app may EXECUTE.
 * - kysely_migration: SELECT, for the schema version in health.
 * - pgboss: the worker's job queue schema; pg-boss creates its own tables in
 *   it, so the app may CREATE there (and nowhere else).
 */
export const AUDIT_APP_COLUMNS = ["actor_user_id", "action", "entity_type", "entity_id", "ip_prefix", "details"] as const;
const BUSINESS_TABLES = ["_meta", "people", "users"] as const;
const app = sql.id(APP_ROLE);
const auditColumns = sql.join(AUDIT_APP_COLUMNS.map((c) => sql.id(c)));

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of BUSINESS_TABLES) await grantAppAccess(db, table);
  await sql`grant select on kysely_migration to ${app}`.execute(db);
  await sql`grant select on audit_log to ${app}`.execute(db);
  await sql`grant insert (${auditColumns}) on audit_log to ${app}`.execute(db);
  await sql`grant execute on function audit_log_retention() to ${app}`.execute(db);
  await sql`create schema pgboss`.execute(db);
  await sql`grant usage, create on schema pgboss to ${app}`.execute(db);
}

/** Revokes every grant above and drops the job queue schema (pending jobs are lost; the worker recreates its schedules). */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop schema pgboss cascade`.execute(db);
  await sql`revoke execute on function audit_log_retention() from ${app}`.execute(db);
  await sql`revoke insert (${auditColumns}) on audit_log from ${app}`.execute(db);
  await sql`revoke all on audit_log, kysely_migration from ${app}`.execute(db);
  for (const table of BUSINESS_TABLES) await sql`revoke all on ${sql.table(table)} from ${app}`.execute(db);
}
