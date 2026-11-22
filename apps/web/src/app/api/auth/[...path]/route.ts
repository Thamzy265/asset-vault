import { getAuth } from "../../../../server/auth.ts";

// The sign-in endpoints (M1.3). The auth service answers every method and path
// itself: the steps it knows take a same-origin JSON POST; anything else is a
// JSON 404 or 405. Better Auth's own handler is never mounted (no sign-up).
export const dynamic = "force-dynamic";

const handle = (request: Request) => getAuth().handle(request);
export const GET = handle;
export const HEAD = handle;
export const OPTIONS = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
