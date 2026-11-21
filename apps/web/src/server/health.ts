import { pingDatabase, readHeartbeat, type Db } from "@vault/db";
import pkg from "../../package.json" with { type: "json" };

/** GET /api/v1/health body. 200 when Postgres answers, 503 when it does not. */
export type HealthBody = {
  status: "ok" | "error";
  db: "ok" | "down";
  version: string;
  /** Last worker heartbeat (ISO 8601), or null if none yet or unknown. Informational only. */
  workerHeartbeat: string | null;
};

export type HealthDeps = {
  ping: () => Promise<void>;
  readHeartbeat: () => Promise<Date | null>;
  version: string;
};

export async function getHealth(deps: HealthDeps): Promise<{ httpStatus: 200 | 503; body: HealthBody }> {
  try {
    await deps.ping();
  } catch {
    return { httpStatus: 503, body: { status: "error", db: "down", version: deps.version, workerHeartbeat: null } };
  }
  const heartbeat = await deps.readHeartbeat().catch(() => null);
  return {
    httpStatus: 200,
    body: { status: "ok", db: "ok", version: deps.version, workerHeartbeat: heartbeat?.toISOString() ?? null },
  };
}

export async function healthResponse(db: Db): Promise<Response> {
  const { httpStatus, body } = await getHealth({
    ping: () => pingDatabase(db),
    readHeartbeat: () => readHeartbeat(db),
    version: pkg.version,
  });
  return Response.json(body, { status: httpStatus, headers: { "cache-control": "no-store" } });
}
