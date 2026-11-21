import { errorCode } from "./log.ts";

export class DatabaseUnavailableError extends Error {
  override name = "DatabaseUnavailableError";
}

/** Wrong password (28P01), no such role or not allowed (28000), no such database (3D000). */
const FATAL_CODES = new Set(["28P01", "28000", "3D000"]);

export type RetryInfo = {
  attempt: number;
  delayMs: number;
  error: unknown;
  /** pg or Node error code (e.g. ECONNREFUSED, 57P03). Safe to log; the error itself is not. */
  code?: string;
};

export type WaitOptions = {
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Returns a factor in (0, 1]; spreads retries so restarts don't stampede. */
  jitter?: () => number;
  onRetry?: (info: RetryInfo) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Calls `check` until it resolves, with capped exponential backoff and
 * jitter. Throws DatabaseUnavailableError once `timeoutMs` (default 60 s)
 * has passed, so the process can exit non-zero and Compose restarts it.
 * Throws at once on a wrong password, role or database name: retrying
 * can't fix those.
 */
export async function waitForDatabase(check: () => Promise<void>, options: WaitOptions = {}): Promise<void> {
  const {
    timeoutMs = 60_000,
    initialDelayMs = 500,
    maxDelayMs = 5_000,
    jitter = () => 0.5 + Math.random() / 2,
    onRetry,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;

  const deadline = now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await check();
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code && FATAL_CODES.has(code)) {
        throw new DatabaseUnavailableError(`Database refused the connection (${code}); check DATABASE_URL`, {
          cause: error,
        });
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new DatabaseUnavailableError(
          `Database unreachable after ${Math.round(timeoutMs / 1000)} s (${attempt} attempts)`,
          { cause: error },
        );
      }
      const backoff = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delayMs = Math.min(Math.round(backoff * jitter()), remaining);
      onRetry?.({ attempt, delayMs, error, ...(code && { code }) });
      await sleep(delayMs);
    }
  }
}
