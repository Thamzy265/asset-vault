import { errorFields, loadDbConfig, log } from "@vault/db";
import { startWorker } from "./worker.ts";

let config;
try {
  config = loadDbConfig(process.env);
} catch (error) {
  log("error", "invalid configuration", errorFields(error));
  process.exit(1);
}

try {
  const worker = await startWorker({ databaseUrl: config.databaseUrl });
  const shutdown = async (signal: string) => {
    log("info", "worker stopping", { signal });
    await worker.stop();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
} catch (error) {
  log("error", "worker failed to start", errorFields(error));
  process.exit(1);
}
