import { readOnlyMethodNotAllowed, readOnlyOptions } from "../../../../server/api-error.ts";
import { getDb } from "../../../../server/db.ts";
import { healthResponse } from "../../../../server/health.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return healthResponse(getDb());
}

// HEAD is derived from GET by Next. Everything else is refused with an Allow header.
export const OPTIONS = readOnlyOptions;
export const POST = readOnlyMethodNotAllowed;
export const PUT = readOnlyMethodNotAllowed;
export const PATCH = readOnlyMethodNotAllowed;
export const DELETE = readOnlyMethodNotAllowed;
