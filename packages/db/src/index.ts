// The public API of @vault/db: what apps may use. No raw client, pool or query
// builder is exported; apps hold an opaque DbHandle (handle.ts).
export { runAuditRetention, type AuditRetentionResult } from "./audit-retention.ts";
export { pingDatabase } from "./client.ts";
export { closeDatabase, openDatabase, type DbHandle } from "./handle.ts";
export { ConfigError, loadDbConfig, type DbConfig } from "./config.ts";
export { readHeartbeat, recordHeartbeat } from "./heartbeat.ts";
export { migrateDown, migrateUp } from "./migrate.ts";
export { migrations } from "./migrations/index.ts";
export type { AuditAction, AuditDetails, Role, Visibility } from "./schema.ts";
export { NotFoundError, PersonInUseError, type RepositoryOptions, type Viewer } from "./access.ts";
export { peopleRepository, type NewPerson, type PeopleRepository, type Person, type PersonChanges } from "./people.ts";
export { errorCode, errorFields, log, type LogLevel } from "./log.ts";
export { waitForDatabaseReady, type DatabaseReadyOptions } from "./database-ready.ts";
export { DatabaseUnavailableError, waitForDatabase, type RetryInfo, type WaitOptions } from "./wait-for-database.ts";
