import { log } from "@vault/db";
import { NextResponse, type NextRequest } from "next/server";
import { badRequest } from "./server/api-error.ts";
import { decodePath, normalisePath } from "./server/gate-path.ts";
import { requireSignedIn } from "./server/session.ts";
import { STATIC_SECURITY_HEADERS, contentSecurityPolicy } from "./server/security-headers.ts";

/**
 * Runs before every request (M1.3; Next.js proxy, Node.js runtime).
 *
 * 1. Default deny for the API: every /api/v1 path except exactly /api/v1/health
 *    needs a session with 2FA passed and an active user. Matched by prefix on the
 *    decoded, normalised path (gate-path.ts: percent-escapes decoded, dot segments
 *    resolved, case folded), so an encoded spelling can't slip past; a path that
 *    fails to decode is refused with 400. A route nobody listed is still covered;
 *    a path no route serves is refused the same way (401/403, not 404). Routes
 *    check the session again themselves when they need the Viewer.
 *    Methods Next itself can't handle (TRACE, ...) never get here: http-gate.mjs
 *    answers them 405 in front of Next.
 * 2. Security headers on every response, with a fresh CSP nonce per request
 *    (Next adds it to its own scripts).
 * 3. A request id (any client value is overwritten), passed to the route and
 *    returned in X-Request-Id.
 */
const PUBLIC_API = new Set(["/api/v1/health", "/api/v1/health/"]);

const API_PREFIX = /^\/api\/v1(\/|$)/;

/**
 * `pathname` is the raw request path; the health route is public only when spelled exactly as it is.
 * Everything else is protected when ANY reading of the path lands in /api/v1: as sent (lower-cased),
 * decoded without touching it (%2F stays a slash-like character the router may treat as part of one
 * segment), or decoded and normalised. Next may route by one reading while a prefix match uses another,
 * so the gate takes the union rather than choosing.
 */
export function isProtectedApi(pathname: string): boolean {
  const decoded = decodePath(pathname);
  const normalised = normalisePath(pathname);
  // A path that can't be decoded is refused by the caller before this is asked; if asked, it is protected.
  if (decoded === null || normalised === null) return true;
  const readings = [pathname.toLowerCase(), decoded.toLowerCase(), decoded.replaceAll("\\", "/").toLowerCase(), normalised];
  if (!readings.some((p) => API_PREFIX.test(p))) return false;
  return !PUBLIC_API.has(pathname);
}

export async function proxy(request: NextRequest): Promise<Response> {
  const started = performance.now();
  const requestId = crypto.randomUUID();
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV === "development");

  const forward = new Headers(request.headers);
  forward.set("x-request-id", requestId);
  forward.set("x-nonce", nonce);
  forward.set("content-security-policy", csp);

  let response: Response;
  if (normalisePath(request.nextUrl.pathname) === null) {
    response = badRequest();
    log("info", "request refused", { requestId, route: "*", method: request.method, status: 400, durationMs: Math.round(performance.now() - started) });
  } else if (isProtectedApi(request.nextUrl.pathname)) {
    const session = await requireSignedIn(request.headers);
    if (session instanceof Response) {
      response = session;
      // Item e: the route as a pattern only; the raw path can hold anything.
      log("info", "api request", { requestId, route: "/api/v1/*", method: request.method, status: response.status, durationMs: Math.round(performance.now() - started) });
    } else {
      response = NextResponse.next({ request: { headers: forward } });
      for (const cookie of session.setCookies) response.headers.append("set-cookie", cookie);
    }
  } else {
    response = NextResponse.next({ request: { headers: forward } });
  }

  response.headers.set("content-security-policy", csp);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) response.headers.set(name, value);
  response.headers.set("x-request-id", requestId);
  return response;
}
