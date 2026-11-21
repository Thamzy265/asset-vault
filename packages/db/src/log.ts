export type LogLevel = "info" | "warn" | "error";

/**
 * One JSON object per line. Callers pass IDs, names and counts only:
 * never request bodies, secrets, connection strings or personal data.
 */
export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === "info") process.stdout.write(`${line}\n`);
  else process.stderr.write(`${line}\n`);
}

// A Postgres SQLSTATE (e.g. 28P01, 3D000) or a Node system error code
// (e.g. ECONNREFUSED, ENOTFOUND). Nothing else is ever returned as a code.
const SAFE_CODE = /^(?:[0-9A-Z]{5}|E[A-Z0-9_]{2,40})$/;

/**
 * The pg or Node error code of `error`, its cause chain or its first
 * AggregateError member. Only the code: never the message, which can hold a
 * user name, host or connection string.
 */
export function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code: unknown = (current as { code?: unknown }).code;
    if (typeof code === "string" && SAFE_CODE.test(code)) return code;
    current = current.cause ?? (current instanceof AggregateError ? current.errors[0] : undefined);
  }
  return undefined;
}

/** Error name, message and code only; never the cause's message (it can hold a connection string). */
export function errorFields(error: unknown): { error: string; code?: string } {
  const code = errorCode(error);
  return {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    ...(code && { code }),
  };
}
