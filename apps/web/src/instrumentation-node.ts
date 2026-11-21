import { createDb, log, pingDatabase, waitForDatabase } from "@vault/db";
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
      const db = createDb(databaseUrl, { maxConnections: 1 });
      try {
        await waitForDatabase(() => pingDatabase(db), {
          onRetry: ({ attempt, delayMs }) => log("warn", "database not reachable, retrying", { attempt, delayMs }),
        });
      } finally {
        await db.destroy();
      }
    },
  });
}
