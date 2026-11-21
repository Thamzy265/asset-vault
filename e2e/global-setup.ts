import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Sign-in rate limits are kept 15 minutes, and without a trusted IP header every client
// shares one per-network budget (20 failures). Earlier e2e runs within 15 minutes would
// otherwise use it up, so each run starts with an empty failure log on the stack under test.
const run = promisify(execFile);
const project = process.env.COMPOSE_PROJECT_NAME ?? "asset-vault";

export default async function globalSetup(): Promise<void> {
  await run(
    "docker",
    ["compose", "-p", project, "exec", "-T", "postgres", "sh", "-c", 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "delete from auth_sign_in_failures"'],
    { timeout: 60_000 },
  );
}
