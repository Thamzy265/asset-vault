/**
 * The one error body every /api/v1 error response uses (ADR 0003: the API is
 * JSON-only, errors included). Messages are fixed strings: never echo the
 * request, a stack trace or anything internal.
 */
export type ApiErrorCode = "not_found";

export type ApiErrorBody = { error: { code: ApiErrorCode; message: string } };

export function apiError(status: number, code: ApiErrorCode, message: string): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return Response.json(body, { status });
}

export function notFound(): Response {
  return apiError(404, "not_found", "No API endpoint at this path.");
}
