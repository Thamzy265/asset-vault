import type { Kysely } from "kysely";
import { pingDatabase } from "./client.ts";
import { log as defaultLog, type LogLevel } from "./log.ts";
import type { Database } from "./schema.ts";
import { waitForDatabase, type WaitOptions } from "./wait-for-database.ts";

export type DatabaseReadyOptions = Pick<WaitOptions, "timeoutMs" | "initialDelayMs"> & {
  log?: (level: LogLevel, msg: string, fields: Record<string, unknown>) => void;
};

/**
 * The start-up wait shared by the web app, the worker and the migrate CLI:
 * pings until Postgres answers (~60 s, backoff), logging each retry with the
 * pg or Node error code only. Rejects with DatabaseUnavailableError.
 */
export async function waitForDatabaseReady(db: Kysely<Database>, options: DatabaseReadyOptions = {}): Promise<void> {
  const { log = defaultLog, ...timing } = options;
  await waitForDatabase(() => pingDatabase(db), {
    ...timing,
    onRetry: ({ attempt, delayMs, code }) =>
      log("warn", "database not reachable, retrying", { attempt, delayMs, ...(code && { code }) }),
  });
}
