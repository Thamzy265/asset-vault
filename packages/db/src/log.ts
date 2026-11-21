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

/** Error name and message only; never the cause chain (it can hold a connection string). */
export function errorFields(error: unknown): { error: string } {
  return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
}
