import { closeDatabase, log, openDatabase, waitForDatabaseReady } from "@vault/db";
import { startupCheck } from "./server/startup.ts";

/** Node.js-only start-up work, loaded from instrumentation.ts. */
export function runNodeStartup(): void {
  // Not awaited: the server starts listening now and health reports 503
  // until Postgres answers; after ~60 s without it the process exits 1.
  void startupCheck({
    env: process.env,
    exit: (code) => process.exit(code),
    log,
    wait: async (databaseUrl) => {
      const db = openDatabase(databaseUrl, { maxConnections: 1 });
      try {
        await waitForDatabaseReady(db);
      } finally {
        await closeDatabase(db);
      }
    },
  });
}
