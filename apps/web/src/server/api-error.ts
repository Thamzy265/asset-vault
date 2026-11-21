/**
 * The one error body every /api/v1 error response uses (ADR 0003: the API is
 * JSON-only, errors included). Messages are fixed strings: never echo the
 * request, a stack trace or anything internal.
 */
export type ApiErrorCode = "not_found" | "method_not_allowed" | "unauthorized" | "2fa_required" | "internal_error" | "unavailable";

export type ApiErrorBody = { error: { code: ApiErrorCode; message: string } };

export function apiError(status: number, code: ApiErrorCode, message: string, headers: HeadersInit = {}): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return Response.json(body, { status, headers });
}

export function notFound(): Response {
  return apiError(404, "not_found", "No API endpoint at this path.");
}

/**
 * For a route that only reads. Next's automatic 405 has no Allow header (RFC 9110
 * requires one), and its automatic OPTIONS would list every exported method, so a
 * read-only route exports these for OPTIONS, POST, PUT, PATCH and DELETE.
 */
const READ_ONLY_ALLOW = { allow: "GET, HEAD, OPTIONS" };

export function readOnlyOptions(): Response {
  return new Response(null, { status: 204, headers: READ_ONLY_ALLOW });
}

export function readOnlyMethodNotAllowed(): Response {
  return apiError(405, "method_not_allowed", "This endpoint only supports GET, HEAD and OPTIONS.", READ_ONLY_ALLOW);
}

/** No session, or it ended (M1.3). */
export function unauthorized(headers: HeadersInit = {}): Response {
  return apiError(401, "unauthorized", "Sign in to continue.", { "cache-control": "no-store", ...headers });
}

/** A session with the password only: two-step sign-in is not set up yet (M1.3). */
export function twoFactorRequired(headers: HeadersInit = {}): Response {
  return apiError(403, "2fa_required", "Finish setting up two-step sign-in to continue.", { "cache-control": "no-store", ...headers });
}

export function internalError(): Response {
  return apiError(500, "internal_error", "Something went wrong. Try again.", { "cache-control": "no-store" });
}

/** The session could not be checked (database down): refused, never let through. */
export function unavailable(): Response {
  return apiError(503, "unavailable", "The service is unavailable. Try again shortly.", { "cache-control": "no-store", "retry-after": "5" });
}
