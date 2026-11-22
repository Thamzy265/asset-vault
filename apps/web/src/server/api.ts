import { errorCode, log } from "@vault/db";
import { internalError } from "./api-error.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The request id the proxy set (it overwrites any client value), or a new one. */
export function requestIdOf(request: Request | undefined): string {
  const given = request?.headers.get("x-request-id");
  return given && UUID.test(given) ? given : crypto.randomUUID();
}

/**
 * Wraps an /api/v1 route handler (M1.3): one structured log line per request
 * (request id, route pattern, method, status, duration) and a JSON 500 for
 * anything thrown. Item e: never the path, query, body, a Postgres detail, an
 * email, code or token; errors are logged as code + route + request id only.
 * `route` is the pattern (e.g. "/api/v1/me"), never the raw path.
 */
export function apiRoute(route: string, handler: (request: Request) => Response | Promise<Response>) {
  // Rest parameters keep the handler's declared arity at 0 (the catch-all test relies on it).
  return async (...args: unknown[]): Promise<Response> => {
    const request = args[0] instanceof Request ? args[0] : undefined;
    const requestId = requestIdOf(request);
    const method = request?.method ?? "GET";
    const started = performance.now();
    let response: Response;
    try {
      response = await handler(request ?? new Request("http://localhost/"));
    } catch (error) {
      const code = errorCode(error);
      log("error", "api request failed", { requestId, route, method, ...(code && { code }) });
      response = internalError();
    }
    response.headers.set("x-request-id", requestId);
    log("info", "api request", { requestId, route, method, status: response.status, durationMs: Math.round(performance.now() - started) });
    return response;
  };
}
