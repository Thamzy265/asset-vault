// Usage: node packages/db/src/cli.ts up|down   (pnpm db:migrate / pnpm db:rollback)
import { createMigrationDb } from "./client.ts";
import { loadDbConfig } from "./config.ts";
import { waitForDatabaseReady } from "./database-ready.ts";
import { errorFields, log } from "./log.ts";
import { migrateDown, migrateUp } from "./migrate.ts";

const command = process.argv[2];
if (command !== "up" && command !== "down") {
  process.stderr.write("usage: cli.ts up|down\n");
  process.exit(1);
}

let config;
try {
  config = loadDbConfig(process.env);
} catch (error) {
  log("error", "invalid configuration", errorFields(error));
  process.exit(1);
}

const db = createMigrationDb(config.databaseUrl);
try {
  await waitForDatabaseReady(db);
  if (command === "up") {
    log("info", "migrations applied", { migrations: await migrateUp(db) });
  } else {
    log("info", "migration reverted", { migrations: await migrateDown(db) });
  }
} catch (error) {
  log("error", `migrate ${command} failed`, errorFields(error));
  process.exitCode = 1;
} finally {
  await db.destroy();
}
