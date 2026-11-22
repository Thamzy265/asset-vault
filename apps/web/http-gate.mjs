// The first thing a request meets, in front of Next (M1.3 T7, T8). Next's own runtime builds a fetch
// Request for every request and throws for methods that fetch forbids (TRACE, CONNECT, TRACK),
// before the proxy (src/proxy.ts, the default-deny gate) can run, which gave an anonymous 500 with a
// stack trace in the log on every path. This wrapper answers any method the app doesn't use with a
// JSON 405 and an Allow header. It also answers /_next/image with a 404: the image optimizer is off
// (images.unoptimized), but Next still tries to create its read-only cache directory before it
// returns the 404, which left an unhandled rejection in the log. Both log a status only (no stack
// trace, no method text or path: they are client-chosen). Plain JavaScript on purpose: it is loaded
// with `node --import` before anything else, in the production image, where no TypeScript runs.

export const SUPPORTED_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

const HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
  connection: "close",
};
const METHOD_BODY = JSON.stringify({ error: { code: "method_not_allowed", message: "This method is not supported." } });
const NOT_FOUND_BODY = JSON.stringify({ error: { code: "not_found", message: "Not found." } });

function refuse(request, response, status, body, extra, write) {
  response.writeHead(status, { ...HEADERS, ...extra, "content-length": Buffer.byteLength(body) });
  response.end(request.method === "HEAD" ? undefined : body);
  if (!request.selfCheck) write(JSON.stringify({ time: new Date().toISOString(), level: "info", msg: "request refused", route: "*", status }));
}

const BAD_TARGET_BODY = JSON.stringify({ error: { code: "bad_request", message: "The request target is not valid." } });

/** The path part of a request target as the optimizer test should see it: leading slashes collapsed, backslashes as slashes. */
function pathOf(target) {
  return target.split("?")[0].replaceAll("\\", "/").replace(/^\/+/, "/");
}

function isOptimizer(target) {
  const raw = pathOf(target);
  let decoded = raw;
  try {
    decoded = pathOf(decodeURIComponent(raw));
  } catch {
    // An undecodable path is the proxy's 400; the raw reading above still applies.
  }
  return raw.startsWith("/_next/image") || decoded.startsWith("/_next/image");
}

/**
 * Wraps a Node request listener so unsupported methods, targets that are not in origin form and the
 * image optimizer are refused before it sees them. Only origin-form targets ("/path?query") reach
 * Next: an absolute-form target ("GET http://host/_next/image") would otherwise be read by Next as a
 * different path than the one tested here (reviewer S4), and nothing in front of the app sends one.
 */
export function guardRequests(listener, write = (line) => process.stdout.write(`${line}\n`)) {
  return function guarded(request, response) {
    if (!SUPPORTED_METHODS.includes(request.method)) return refuse(request, response, 405, METHOD_BODY, { allow: SUPPORTED_METHODS.join(", ") }, write);
    const target = request.url ?? "";
    if (!target.startsWith("/")) return refuse(request, response, 400, BAD_TARGET_BODY, {}, write);
    if (isOptimizer(target)) return refuse(request, response, 404, NOT_FOUND_BODY, {}, write);
    return listener(request, response);
  };
}

/** Makes every http.createServer(listener) in this process guard its listener. */
export function installRequestGuard(http) {
  const create = http.createServer;
  http.createServer = function createServer(...args) {
    const at = args.findIndex((arg) => typeof arg === "function");
    if (at >= 0) {
      args[at] = guardRequests(args[at]);
      globalThis.__vaultGuardedServers = (globalThis.__vaultGuardedServers ?? 0) + 1;
    }
    return create.apply(this, args);
  };
  http.createServer.requestGuard = true;
}

/**
 * Start-up self-check: proves the patch is in place by driving a TRACE through a server made with the
 * patched createServer. Throws if the request reaches the listener, so a changed Next or Node that
 * bypasses the patch stops the process at start instead of silently losing the 405 (reviewer S4).
 */
export async function selfCheck(http) {
  if (http.createServer.requestGuard !== true) throw new Error("request guard is not installed on http.createServer");
  let reached = false;
  const server = http.createServer(() => {
    reached = true;
  });
  globalThis.__vaultGuardedServers -= 1; // the self-check's own server is not the web server
  const listener = server.listeners("request")[0];
  let status = 0;
  const response = { writeHead: (code) => (status = code), end: () => {} };
  listener({ method: "TRACE", url: "/", selfCheck: true }, response);
  if (reached || status !== 405) throw new Error("request guard is not in place: a TRACE reached the listener");
}
