import { sql, type ColumnDefinitionBuilder, type Kysely } from "kysely";
import { APP_ROLE } from "./record-columns.ts";

/**
 * Sign-in with mandatory 2FA (design note M1.3). Better Auth's tables, written
 * here by hand rather than by its CLI so the change is reversible and reviewed.
 * They mirror the schema of the pinned better-auth version (packages/db
 * package.json) with the model and field names in src/auth/options.ts;
 * test/auth-schema.test.ts asks the library's own migration planner to confirm
 * nothing is missing. This migration's literals are frozen with it.
 *
 * - auth_users: Better Auth's `user` model, 1:1 with users (same id). The
 *   access-control row (role, person, deactivation) stays in users; the
 *   personal sign-in data lives here and is deleted on deactivation.
 * - auth_sessions, auth_accounts (password hash), auth_verifications (short-
 *   lived challenges), auth_two_factors (encrypted TOTP secret, hashed backup
 *   codes): the library's tables.
 * - auth_setup_tokens: our one-time setup links (hashed, 24 h, single use).
 * - auth_sign_in_failures: failed password attempts, kept 15 minutes, for the
 *   rate limits.
 *
 * Item (d): every foreign key cascades, so deleting a user (only the retention
 * function does) can never fail on an auth row.
 */
const app = sql.id(APP_ROLE);

export async function up(db: Kysely<unknown>): Promise<void> {
  const id = (c: ColumnDefinitionBuilder) => c.primaryKey().defaultTo(sql`gen_random_uuid()`);
  const now = sql`now()`;

  await db.schema
    .createTable("auth_users")
    .addColumn("id", "uuid", (c) => c.primaryKey().references("users.id").onDelete("cascade"))
    .addColumn("email", "text", (c) => c.notNull().unique().check(sql`email = lower(email) and char_length(email) between 3 and 254`))
    .addColumn("name", "text", (c) => c.notNull().check(sql`char_length(name) between 1 and 100`))
    .addColumn("email_verified", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("image", "text")
    .addColumn("two_factor_enabled", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();

  await db.schema
    .createTable("auth_sessions")
    .addColumn("id", "uuid", id)
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("token", "text", (c) => c.notNull().unique())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("ip_address", "text")
    .addColumn("user_agent", "text")
    .addColumn("user_id", "uuid", (c) => c.notNull().references("auth_users.id").onDelete("cascade"))
    .execute();
  await db.schema.createIndex("auth_sessions_user_id_idx").on("auth_sessions").column("user_id").execute();

  await db.schema
    .createTable("auth_accounts")
    .addColumn("id", "uuid", id)
    .addColumn("account_id", "text", (c) => c.notNull())
    .addColumn("provider_id", "text", (c) => c.notNull())
    .addColumn("user_id", "uuid", (c) => c.notNull().references("auth_users.id").onDelete("cascade"))
    .addColumn("access_token", "text")
    .addColumn("refresh_token", "text")
    .addColumn("id_token", "text")
    .addColumn("access_token_expires_at", "timestamptz")
    .addColumn("refresh_token_expires_at", "timestamptz")
    .addColumn("scope", "text")
    .addColumn("password", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addUniqueConstraint("auth_accounts_provider_account_key", ["provider_id", "account_id"])
    .execute();
  await db.schema.createIndex("auth_accounts_user_id_idx").on("auth_accounts").column("user_id").execute();

  await db.schema
    .createTable("auth_verifications")
    .addColumn("id", "uuid", id)
    .addColumn("identifier", "text", (c) => c.notNull())
    .addColumn("value", "text", (c) => c.notNull())
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();
  await db.schema.createIndex("auth_verifications_identifier_idx").on("auth_verifications").column("identifier").execute();

  await db.schema
    .createTable("auth_two_factors")
    .addColumn("id", "uuid", id)
    .addColumn("secret", "text", (c) => c.notNull())
    .addColumn("backup_codes", "text", (c) => c.notNull())
    .addColumn("user_id", "uuid", (c) => c.notNull().unique().references("auth_users.id").onDelete("cascade"))
    .addColumn("verified", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("failed_verification_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("locked_until", "timestamptz")
    .execute();
  await db.schema.createIndex("auth_two_factors_secret_idx").on("auth_two_factors").column("secret").execute();

  await db.schema
    .createTable("auth_setup_tokens")
    .addColumn("id", "uuid", id)
    .addColumn("user_id", "uuid", (c) => c.notNull().references("auth_users.id").onDelete("cascade"))
    .addColumn("token_hash", "text", (c) => c.notNull().unique())
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();
  await db.schema.createIndex("auth_setup_tokens_user_id_idx").on("auth_setup_tokens").column("user_id").execute();

  await db.schema
    .createTable("auth_sign_in_failures")
    .addColumn("id", "bigint", (c) => c.primaryKey().generatedAlwaysAsIdentity())
    .addColumn("account_key", "text", (c) => c.notNull())
    .addColumn("ip_key", "text", (c) => c.notNull())
    .addColumn("at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();
  await db.schema.createIndex("auth_sign_in_failures_account_idx").on("auth_sign_in_failures").columns(["account_key", "at"]).execute();
  await db.schema.createIndex("auth_sign_in_failures_ip_idx").on("auth_sign_in_failures").columns(["ip_key", "at"]).execute();

  // Grants (design note M1.2, decision 3; recorded in test/roles.test.ts). The library
  // reads, writes and deletes its own rows; setup tokens and failures are never edited,
  // only added and removed.
  for (const table of ["auth_users", "auth_sessions", "auth_accounts", "auth_verifications", "auth_two_factors"]) {
    await sql`grant select, insert, update, delete on ${sql.table(table)} to ${app}`.execute(db);
  }
  for (const table of ["auth_setup_tokens", "auth_sign_in_failures"]) {
    await sql`grant select, insert, delete on ${sql.table(table)} to ${app}`.execute(db);
  }
}

/** Drops every auth table (no real users yet, design note M1.3 rollout); grants go with them. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table auth_sign_in_failures, auth_setup_tokens, auth_two_factors, auth_verifications, auth_accounts, auth_sessions, auth_users`.execute(db);
}
