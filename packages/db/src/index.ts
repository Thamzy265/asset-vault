// The public API of @vault/db: what apps may use. No raw client, pool or query
// builder is exported; apps hold an opaque DbHandle (handle.ts).
export { runAuditRetention, type AuditRetentionResult } from "./audit-retention.ts";
export { pingDatabase } from "./client.ts";
export { closeDatabase, openDatabase, type DbHandle } from "./handle.ts";
export { ConfigError, loadDbConfig, type DbConfig } from "./config.ts";
export { readHeartbeat, recordHeartbeat } from "./heartbeat.ts";
export { EXPECTED_SCHEMA_VERSION, readSchemaVersion } from "./schema-version.ts";
export type { AuditAction, AuditDetails, Role, Visibility } from "./schema.ts";
export { ForbiddenError, NotFoundError, PersonInUseError, ValidationError, type RepositoryOptions, type Viewer } from "./access.ts";
export { peopleRepository, type NewPerson, type PeopleRepository, type Person, type PersonChanges } from "./people.ts";
export { errorCode, errorFields, log, type LogLevel } from "./log.ts";
export { waitForDatabaseReady, type DatabaseReadyOptions } from "./database-ready.ts";
export { DatabaseUnavailableError, waitForDatabase, type RetryInfo, type WaitOptions } from "./wait-for-database.ts";
// Sign-in (M1.3). The session check in createAuthService().session() is the only
// place a Viewer is created (auth/session.ts); mintViewer itself is not exported.
export { loadAuthConfig, type AuthConfig } from "./auth/config.ts";
export { createAuthService, type AuthService, type AuthServiceOptions } from "./auth/service.ts";
export type { SessionState, SessionUser } from "./auth/session.ts";
