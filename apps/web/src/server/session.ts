import type { SessionState, SessionUser, Viewer } from "@vault/db";
import { twoFactorRequired, unauthorized, unavailable } from "./api-error.ts";
import { errorCode, log } from "@vault/db";
import { getAuth } from "./auth.ts";

export type SignedIn = { viewer: Viewer; user: SessionUser; setCookies: string[] };

/**
 * The session for a request (M1.3). A Viewer comes only from here: it is the
 * session module's, created for a live, active user with 2FA passed. Anything
 * else is the refusal to send: 401 (no session, or it ended), 403
 * 2fa_required (password only), 503 when the session can't be checked.
 */
export async function requireSignedIn(headers: Headers): Promise<SignedIn | Response> {
  let state: SessionState;
  try {
    state = await getAuth().session(headers);
  } catch (error) {
    const code = errorCode(error);
    log("error", "session check failed", { ...(code && { code }) });
    return unavailable();
  }
  if (state.status === "signed-in") return { viewer: state.viewer, user: state.user, setCookies: state.setCookies };
  const response = state.status === "two-factor-required" ? twoFactorRequired() : unauthorized();
  for (const cookie of state.setCookies) response.headers.append("set-cookie", cookie);
  return response;
}
