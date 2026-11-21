import { sql, type Kysely } from "kysely";

/**
 * Append-only audit log (design note M1.2). A trigger refuses UPDATE, DELETE
 * and TRUNCATE. The one exception is audit_log_retention(), run nightly by the
 * worker: it deletes rows older than 2 years and clears ip_prefix after 90
 * days, then deletes deactivated users with no audit rows left (decision 8). The trigger checks those rules itself too, so setting the retention
 * flag by hand can't remove or edit anything retention wouldn't.
 */
export const AUDIT_ACTIONS = [
  "view",
  "create",
  "update",
  "delete",
  "sign_in",
  "sign_in_failed",
  "sign_out",
  "2fa_enrolled",
  "2fa_failed",
  "password_changed",
  "backup_code_used",
] as const;

/** The audit actions that may carry an ip_prefix (design note M1.2, decision 4). */
export const IP_PREFIX_ACTIONS = ["sign_in", "sign_in_failed", "2fa_failed", "backup_code_used"] as const;

const list = (values: readonly string[]) => sql.join(values.map((v) => sql.lit(v)));

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("audit_log")
    .addColumn("id", "bigint", (c) => c.primaryKey().generatedAlwaysAsIdentity())
    .addColumn("at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    // RESTRICT on purpose (decision 8): a user who appears in the log is deactivated, not
    // deleted; retention deletes the user row once its last audit row has expired.
    .addColumn("actor_user_id", "uuid", (c) => c.references("users.id").onDelete("restrict"))
    .addColumn("action", "text", (c) => c.notNull().check(sql`action in (${list(AUDIT_ACTIONS)})`))
    .addColumn("entity_type", "text", (c) => c.check(sql`entity_type ~ '^[a-z][a-z_]{0,49}$'`))
    .addColumn("entity_id", "uuid")
    .addColumn("ip_prefix", "text")
    .addColumn("details", "jsonb")
    .addCheckConstraint("audit_log_entity_pair", sql`(entity_type is null) = (entity_id is null)`)
    .addCheckConstraint(
      "audit_log_record_action_has_entity",
      sql`action not in ('view', 'create', 'update', 'delete') or entity_id is not null`,
    )
    // Minimisation: a /24 or /48 prefix, never a full address, and only on the events
    // that show where a sign-in attempt came from (decision 4).
    .addCheckConstraint(
      "audit_log_ip_prefix",
      sql`ip_prefix is null or (
        action in (${list(IP_PREFIX_ACTIONS)})
        and ip_prefix ~ '^[0-9a-fA-F:.]+/[0-9]{1,3}$'
        and ((family(ip_prefix::cidr) = 4 and masklen(ip_prefix::cidr) = 24)
          or (family(ip_prefix::cidr) = 6 and masklen(ip_prefix::cidr) = 48)))`,
    )
    // Names of changed fields only, never values: {"fields": ["display_name", ...]}.
    .addCheckConstraint(
      "audit_log_details_field_names_only",
      sql`details is null or (
        jsonb_typeof(details) = 'object'
        and details - 'fields' = '{}'::jsonb
        and jsonb_typeof(details -> 'fields') = 'array'
        and not jsonb_path_exists(details, '$.fields[*] ? (@.type() != "string" || !(@ like_regex "^[a-z][a-z0-9_]{0,62}$"))'))`,
    )
    .execute();

  await sql`
    create function audit_log_guard() returns trigger language plpgsql as $$
    begin
      if tg_op = 'TRUNCATE' then
        raise exception 'audit_log is append-only' using errcode = '42501';
      end if;
      if current_setting('vault.audit_retention', true) is distinct from 'on' then
        raise exception 'audit_log is append-only' using errcode = '42501';
      end if;
      if tg_op = 'DELETE' then
        if old.at >= now() - interval '2 years' then
          raise exception 'audit_log rows are kept for 2 years' using errcode = '42501';
        end if;
        return old;
      end if;
      -- UPDATE: retention may only clear the ip_prefix of a row older than 90 days.
      if old.at >= now() - interval '90 days'
         or new.ip_prefix is not null
         or (new.id, new.at, new.actor_user_id, new.action, new.entity_type, new.entity_id, new.details)
            is distinct from (old.id, old.at, old.actor_user_id, old.action, old.entity_type, old.entity_id, old.details) then
        raise exception 'audit_log is append-only' using errcode = '42501';
      end if;
      return new;
    end $$`.execute(db);
  await sql`
    create trigger audit_log_append_only before update or delete on audit_log
    for each row execute function audit_log_guard()`.execute(db);
  await sql`
    create trigger audit_log_no_truncate before truncate on audit_log
    for each statement execute function audit_log_guard()`.execute(db);

  await sql`
    create function audit_log_retention(out deleted bigint, out ip_prefixes_cleared bigint, out users_deleted bigint)
    language plpgsql as $$
    begin
      perform set_config('vault.audit_retention', 'on', true);
      delete from audit_log where at < now() - interval '2 years';
      get diagnostics deleted = row_count;
      update audit_log set ip_prefix = null where ip_prefix is not null and at < now() - interval '90 days';
      get diagnostics ip_prefixes_cleared = row_count;
      perform set_config('vault.audit_retention', 'off', true);
      delete from users u
        where u.deactivated_at is not null
          and not exists (select 1 from audit_log a where a.actor_user_id = u.id);
      get diagnostics users_deleted = row_count;
    end $$`.execute(db);
}

/**
 * Refuses while audit_log has rows (decision 5): history is never dropped by a
 * routine rollback. Export the log first; removing it is then a deliberate
 * admin step, not a migration.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    do $$
    begin
      if exists (select 1 from audit_log) then
        raise exception 'Rollback of 0003_audit_log refused: audit_log has rows. Export the audit log first (README, "Rolling back a release"); a routine rollback never drops audit history.'
          using errcode = '55000';
      end if;
    end $$`.execute(db);
  await db.schema.dropTable("audit_log").execute();
  await sql`drop function audit_log_retention()`.execute(db);
  await sql`drop function audit_log_guard()`.execute(db);
}
