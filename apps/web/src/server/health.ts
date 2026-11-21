import { EXPECTED_SCHEMA_VERSION, pingDatabase, readHeartbeat, readSchemaVersion, type DbHandle } from "@vault/db";
import pkg from "../../package.json" with { type: "json" };

/**
 * GET /api/v1/health body. 200 when Postgres answers and its schema is the one
 * this code expects; 503 when Postgres is down or the schema differs (review L7).
 */
export type HealthBody = {
  status: "ok" | "error";
  db: "ok" | "down";
  version: string;
  /** Migration names: the last one in this code, and the last one applied (null if unknown or none). */
  schema: { expected: string; applied: string | null };
  /** Last worker heartbeat (ISO 8601), or null if none yet or unknown. Informational only. */
  workerHeartbeat: string | null;
};

export type HealthDeps = {
  ping: () => Promise<void>;
  readHeartbeat: () => Promise<Date | null>;
  readSchemaVersion: () => Promise<string | null>;
  expectedSchemaVersion: string;
  version: string;
};

export async function getHealth(deps: HealthDeps): Promise<{ httpStatus: 200 | 503; body: HealthBody }> {
  const expected = deps.expectedSchemaVersion;
  try {
    await deps.ping();
  } catch {
    return {
      httpStatus: 503,
      body: { status: "error", db: "down", version: deps.version, schema: { expected, applied: null }, workerHeartbeat: null },
    };
  }
  const applied = await deps.readSchemaVersion().catch(() => null);
  const heartbeat = await deps.readHeartbeat().catch(() => null);
  const schemaOk = applied === expected;
  return {
    httpStatus: schemaOk ? 200 : 503,
    body: {
      status: schemaOk ? "ok" : "error",
      db: "ok",
      version: deps.version,
      schema: { expected, applied },
      workerHeartbeat: heartbeat?.toISOString() ?? null,
    },
  };
}

export async function healthResponse(db: DbHandle): Promise<Response> {
  const { httpStatus, body } = await getHealth({
    ping: () => pingDatabase(db),
    readHeartbeat: () => readHeartbeat(db),
    readSchemaVersion: () => readSchemaVersion(db),
    expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
    version: pkg.version,
  });
  return Response.json(body, { status: httpStatus, headers: { "cache-control": "no-store" } });
}
