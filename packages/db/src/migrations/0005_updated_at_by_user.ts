import { sql, type Kysely } from "kysely";

/**
 * M1.3 carried item C1. Deactivation ships in M1.3, so the nightly retention
 * now deletes user rows, and the ON DELETE SET NULL on every
 * created_by_user_id / updated_by_user_id becomes an UPDATE of the referencing
 * row. That UPDATE is nobody's change and has no audit row, so it must not move
 * updated_at. set_updated_at() now moves updated_at only when a column other
 * than updated_at and the *_by_user_id columns changed; otherwise it keeps the
 * old value (so updated_at still can't be forged by naming it in an UPDATE).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create or replace function set_updated_at() returns trigger language plpgsql as $$
    begin
      if exists (
        select 1 from jsonb_each(to_jsonb(new)) as n(key, value)
        where n.key <> 'updated_at'
          and n.key !~ '_by_user_id$'
          and n.value is distinct from (to_jsonb(old) -> n.key)
      ) then
        new.updated_at := now();
      else
        new.updated_at := old.updated_at;
      end if;
      return new;
    end $$`.execute(db);
}

/** Restores 0002's function: every UPDATE moves updated_at. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    create or replace function set_updated_at() returns trigger language plpgsql as $$
    begin
      new.updated_at := now();
      return new;
    end $$`.execute(db);
}
