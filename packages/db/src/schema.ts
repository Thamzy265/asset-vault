import type { ColumnType, Generated } from "kysely";
import type { AUDIT_ACTIONS, VISIBILITIES } from "./rules.ts";

/** System key/value table. No personal data is ever stored here. */
export interface MetaTable {
  key: string;
  value: string;
  updated_at: Generated<Date>;
}

export type Visibility = (typeof VISIBILITIES)[number];
export type Role = "admin" | "member";
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The common record columns every business table carries (migrations/record-columns.ts). */
export interface RecordColumns {
  id: Generated<string>;
  owner_person_id: string | null;
  visibility: Generated<Visibility>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
  created_by_user_id: ColumnType<string | null, string | null, never>;
  updated_by_user_id: string | null;
}

/** Family members who own things, are insured, or are beneficiaries. Login optional. */
export interface PeopleTable extends RecordColumns {
  display_name: string;
  relationship: string | null;
}

/** Logins: link to a person, a role, and deactivation. Sign-in data lives in auth_users (1:1, M1.3). */
export interface UsersTable {
  id: Generated<string>;
  person_id: string | null;
  role: Generated<Role>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
  /** Set when the login is removed (decision 8); the row is deleted once its last audit row expires. */
  deactivated_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

/**
 * Better Auth's `user` model (M1.3, migration 0007): the sign-in side of a
 * login, 1:1 with users (same id). Deleted when the user is deactivated, which
 * also deletes their sessions, password, two-factor secret, backup codes and
 * setup links (ON DELETE CASCADE).
 */
export interface AuthUsersTable {
  id: string;
  /** Lower case. */
  email: string;
  name: string;
  email_verified: Generated<boolean>;
  /** Better Auth field; always null (no profile images). */
  image: string | null;
  two_factor_enabled: Generated<boolean>;
  created_at: ColumnType<Date, Date | undefined, Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** Better Auth `session`. No IP address is stored (ip_address stays null). */
export interface AuthSessionsTable {
  id: Generated<string>;
  expires_at: Date;
  token: string;
  created_at: ColumnType<Date, Date | undefined, Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
  ip_address: string | null;
  user_agent: string | null;
  user_id: string;
}

/** Better Auth `account`: only the "credential" provider is used, holding the password hash. */
export interface AuthAccountsTable {
  id: Generated<string>;
  account_id: string;
  provider_id: string;
  user_id: string;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
  access_token_expires_at: Date | null;
  refresh_token_expires_at: Date | null;
  scope: string | null;
  /** scrypt hash (salt:key, hex). */
  password: string | null;
  created_at: ColumnType<Date, Date | undefined, Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** Better Auth `verification`: short-lived values such as the sign-in two-factor challenge. */
export interface AuthVerificationsTable {
  id: Generated<string>;
  identifier: string;
  value: string;
  expires_at: Date;
  created_at: ColumnType<Date, Date | undefined, Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** Better Auth two-factor plugin: the TOTP secret (encrypted) and backup codes (keyed hashes, JSON list). */
export interface AuthTwoFactorsTable {
  id: Generated<string>;
  secret: string;
  backup_codes: string;
  user_id: string;
  verified: Generated<boolean>;
  failed_verification_count: Generated<number>;
  locked_until: Date | null;
}

/** One-time setup links (`pnpm user:create`): SHA-256 of the token only, single use, 24 h. */
export interface AuthSetupTokensTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Generated<Date>;
}

/**
 * Failed password attempts, kept 15 minutes for the rate limits. account_key is
 * a keyed hash of the email typed (known or not); ip_key the client's IP prefix,
 * or "unknown".
 */
export interface AuthSignInFailuresTable {
  id: Generated<string>;
  account_key: string;
  ip_key: string;
  at: Generated<Date>;
}

/** Names of changed fields only, never their values. */
export type AuditDetails = { fields: string[] };

/** Append-only: the database refuses UPDATE and DELETE (except retention). */
export interface AuditLogTable {
  id: ColumnType<string, never, never>;
  at: ColumnType<Date, never, never>;
  actor_user_id: string | null;
  action: AuditAction;
  entity_type: string | null;
  entity_id: string | null;
  ip_prefix: string | null;
  details: ColumnType<AuditDetails | null, string | null, never>;
}

export interface Database {
  _meta: MetaTable;
  people: PeopleTable;
  users: UsersTable;
  audit_log: AuditLogTable;
  auth_users: AuthUsersTable;
  auth_sessions: AuthSessionsTable;
  auth_accounts: AuthAccountsTable;
  auth_verifications: AuthVerificationsTable;
  auth_two_factors: AuthTwoFactorsTable;
  auth_setup_tokens: AuthSetupTokensTable;
  auth_sign_in_failures: AuthSignInFailuresTable;
}
