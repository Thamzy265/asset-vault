/** Client side of /api/auth and /api/v1 (M1.3): JSON in, JSON out, offline told apart. */
export type ApiResult = { status: number; body: Record<string, unknown> };

export class OfflineError extends Error {
  override name = "OfflineError";
}

export async function postJson(path: string, body: unknown = {}): Promise<ApiResult> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new OfflineError();
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new OfflineError();
  }
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed };
}

export function errorCodeOf(result: ApiResult): string | undefined {
  const error = result.body.error as { code?: string } | undefined;
  return error?.code;
}

export function errorMessageOf(result: ApiResult): string | undefined {
  const error = result.body.error as { message?: string } | undefined;
  return error?.message;
}
