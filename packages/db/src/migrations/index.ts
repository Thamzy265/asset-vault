// Merged migrations are frozen: never edit one after it reaches main. A rule
// change is a new migration. Live code takes its rules from ../rules.ts, never
// from here; test/live-rules.test.ts checks the two still agree (review L6).
import type { Migration } from "kysely/migration";
import * as m0001 from "./0001_meta.ts";
import * as m0002 from "./0002_people_users.ts";
import * as m0003 from "./0003_audit_log.ts";
import * as m0004 from "./0004_database_roles.ts";
import * as m0005 from "./0005_updated_at_by_user.ts";
import * as m0006 from "./0006_users_no_app_delete.ts";

/**
 * Every migration, in order. Each one exports an explicit `up` and `down`.
 * Listed statically (not read from disk) so they work the same in tests,
 * the worker image and the CLI.
 */
export const migrations: Record<string, Migration> = {
  "0001_meta": m0001,
  "0002_people_users": m0002,
  "0003_audit_log": m0003,
  "0004_database_roles": m0004,
  "0005_updated_at_by_user": m0005,
  "0006_users_no_app_delete": m0006,
};
