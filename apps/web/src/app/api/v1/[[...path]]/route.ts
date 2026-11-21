import { notFound } from "../../../../server/api-error.ts";

// Catch-all for /api/v1 paths no other route matches, so they get a JSON 404
// instead of the HTML not-found page. Every method is exported: otherwise Next
// would answer OPTIONS with an automatic 204 and other methods with a bare 405.
export const dynamic = "force-dynamic";

export const GET = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
