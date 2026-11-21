import { z } from "zod";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export type DbConfig = { databaseUrl: string };

const schema = z.object({
  DATABASE_URL: z
    .string({ error: "is required" })
    .min(1, { error: "is required" })
    .refine((value) => /^postgres(ql)?:\/\/.+/.test(value), {
      error: "must be a postgres:// URL",
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
