// Compose healthcheck: `node apps/worker/src/healthcheck.ts` exits 0 when the
// heartbeat job ran recently, 1 otherwise.
import { createDb, loadDbConfig, readHeartbeat } from "@vault/db";

/** The job runs every minute; allow a little over two missed runs. */
export const HEARTBEAT_MAX_AGE_MS = 150_000;

export function isHeartbeatFresh(last: Date | null, now: Date): boolean {
  return last !== null && now.getTime() - last.getTime() <= HEARTBEAT_MAX_AGE_MS;
}

if (import.meta.main) {
  const db = createDb(loadDbConfig(process.env).databaseUrl, { maxConnections: 1 });
  try {
    process.exitCode = isHeartbeatFresh(await readHeartbeat(db), new Date()) ? 0 : 1;
  } catch {
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}
