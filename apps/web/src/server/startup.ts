import { errorFields, loadAuthConfig, loadDbConfig, type LogLevel } from "@vault/db";

export type StartupDeps = {
  env: Record<string, string | undefined>;
  exit: (code: number) => void;
  log: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
  /** Resolves once Postgres answers; rejects after the ~60 s retry window. */
  wait: (databaseUrl: string) => Promise<void>;
};

/**
 * Runs once when the server starts. Bad config exits at once; an unreachable
 * database exits after the retry window so Compose restarts the container.
 * The server keeps serving meanwhile, and /api/v1/health answers 503.
 */
export async function startupCheck(deps: StartupDeps): Promise<void> {
  let databaseUrl: string;
  try {
    databaseUrl = loadDbConfig(deps.env).databaseUrl;
    loadAuthConfig(deps.env); // M1.3: fail at start on bad sign-in settings, not at the first sign-in
  } catch (error) {
    deps.log("error", "invalid configuration", errorFields(error));
    deps.exit(1);
    return;
  }
  try {
    await deps.wait(databaseUrl);
    deps.log("info", "database reachable");
  } catch (error) {
    deps.log("error", "database unreachable, exiting", errorFields(error));
    deps.exit(1);
  }
}
