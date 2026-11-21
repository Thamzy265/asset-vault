import { getDb } from "../../../../server/db.ts";
import { healthResponse } from "../../../../server/health.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return healthResponse(getDb());
}
