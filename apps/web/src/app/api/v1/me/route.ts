import { readOnlyMethodNotAllowed, readOnlyOptions } from "../../../../server/api-error.ts";
import { apiRoute } from "../../../../server/api.ts";
import { requireSignedIn } from "../../../../server/session.ts";

export const dynamic = "force-dynamic";

/** GET /api/v1/me (M1.3): who is signed in. Only the four fields the screens need. */
export const GET = apiRoute("/api/v1/me", async (request) => {
  const session = await requireSignedIn(request.headers);
  if (session instanceof Response) return session;
  const { id, name, role, personId } = session.user;
  const response = Response.json({ id, name, role, personId }, { headers: { "cache-control": "no-store" } });
  for (const cookie of session.setCookies) response.headers.append("set-cookie", cookie);
  return response;
});

// HEAD is derived from GET by Next. Everything else is refused with an Allow header.
export const OPTIONS = apiRoute("/api/v1/me", readOnlyOptions);
export const POST = apiRoute("/api/v1/me", readOnlyMethodNotAllowed);
export const PUT = apiRoute("/api/v1/me", readOnlyMethodNotAllowed);
export const PATCH = apiRoute("/api/v1/me", readOnlyMethodNotAllowed);
export const DELETE = apiRoute("/api/v1/me", readOnlyMethodNotAllowed);
