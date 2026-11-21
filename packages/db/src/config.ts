import { z } from "zod";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export type DbConfig = { databaseUrl: string };

/**
 * Parses the URL the way pg will, so a value pg cannot use fails here, at start,
 * instead of inside the 60 s connection retry. Returns the rule that failed, or
 * null. Never returns or keeps anything from the value itself.
 */
function postgresUrlProblem(value: string): string | null {
  // Checked on the raw text: the URL parser would lower-case the scheme and trim spaces.
  if (!/^postgres(ql)?:\/\//.test(value)) return "must be a postgres:// URL";
  let url: URL;
  try {
    url = new URL(value); // also rejects a non-numeric or out-of-range port
  } catch {
    return "must be a valid postgres:// URL (check the host and port)";
  }
  if (url.hostname === "") return "must include a host";
  if (url.pathname.length <= 1) return "must include a database name";
  return null;
}

const schema = z.object({
  DATABASE_URL: z
    .string({ error: "is required" })
    .min(1, { error: "is required" })
    .superRefine((value, ctx) => {
      const problem = postgresUrlProblem(value);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
});

/**
 * Validates the environment at start-up. Error messages name the variable
 * and the rule, never the value, because the URL contains the password.
 */
export function loadDbConfig(env: Record<string, string | undefined>): DbConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`);
    throw new ConfigError(`Invalid configuration: ${problems.join("; ")}`);
  }
  return { databaseUrl: result.data.DATABASE_URL };
}
