import type { ColumnType, Generated } from "kysely";
import type { AUDIT_ACTIONS } from "./migrations/0003_audit_log.ts";
import type { VISIBILITIES } from "./migrations/record-columns.ts";

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

/** Logins: link to a person and a role only (M1.3 adds the auth tables). */
export interface UsersTable {
  id: Generated<string>;
  person_id: string | null;
  role: Generated<Role>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
  /** Set when the login is removed (decision 8); the row is deleted once its last audit row expires. */
  deactivated_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
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
}
