/**
 * The one error body every /api/v1 error response uses (ADR 0003: the API is
 * JSON-only, errors included). Messages are fixed strings: never echo the
 * request, a stack trace or anything internal.
 */
export type ApiErrorCode = "not_found" | "method_not_allowed";

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
