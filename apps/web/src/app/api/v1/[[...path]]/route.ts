import { notFound } from "../../../../server/api-error.ts";
import { apiRoute } from "../../../../server/api.ts";

// Catch-all for /api/v1 paths no other route matches, so they get a JSON 404
// instead of the HTML not-found page. Every method is exported: otherwise Next
// would answer OPTIONS with an automatic 204 and other methods with a bare 405.
// Since M1.3 the proxy refuses these paths without a signed-in session first.
export const dynamic = "force-dynamic";

const ROUTE = "/api/v1/*";
export const GET = apiRoute(ROUTE, notFound);
export const HEAD = apiRoute(ROUTE, notFound);
export const OPTIONS = apiRoute(ROUTE, notFound);
export const POST = apiRoute(ROUTE, notFound);
export const PUT = apiRoute(ROUTE, notFound);
export const PATCH = apiRoute(ROUTE, notFound);
export const DELETE = apiRoute(ROUTE, notFound);
