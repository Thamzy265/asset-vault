import { readOnlyMethodNotAllowed, readOnlyOptions } from "../../../../server/api-error.ts";
import { apiRoute } from "../../../../server/api.ts";
import { getDb } from "../../../../server/db.ts";
import { healthResponse } from "../../../../server/health.ts";

export const dynamic = "force-dynamic";

const ROUTE = "/api/v1/health";
export const GET = apiRoute(ROUTE, () => healthResponse(getDb()));

// HEAD is derived from GET by Next. Everything else is refused with an Allow header.
export const OPTIONS = apiRoute(ROUTE, readOnlyOptions);
export const POST = apiRoute(ROUTE, readOnlyMethodNotAllowed);
export const PUT = apiRoute(ROUTE, readOnlyMethodNotAllowed);
export const PATCH = apiRoute(ROUTE, readOnlyMethodNotAllowed);
export const DELETE = apiRoute(ROUTE, readOnlyMethodNotAllowed);
