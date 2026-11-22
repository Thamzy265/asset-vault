// The first thing a request meets, in front of Next (M1.3 T7, T8). Next's own runtime builds a fetch
// Request for every request and throws for methods that fetch forbids (TRACE, CONNECT, TRACK),
// before the proxy (src/proxy.ts, the default-deny gate) can run, which gave an anonymous 500 with a
// stack trace in the log on every path. This wrapper answers any method the app doesn't use with a
// JSON 405 and an Allow header. It also answers /_next/image with a 404: the image optimizer is off
// (images.unoptimized), but Next still tries to create its read-only cache directory before it
// returns the 404, which left an unhandled rejection in the log. Both log a status only (no stack
// trace, no method text or path: they are client-chosen). Plain JavaScript on purpose: it is loaded with `node --import` before anything
// else, in the production image, where no TypeScript runs.

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
  write(JSON.stringify({ time: new Date().toISOString(), level: "info", msg: "request refused", route: "*", status }));
}

/** Wraps a Node request listener so unsupported methods and the image optimizer are refused before it sees them. */
export function guardRequests(listener, write = (line) => process.stdout.write(`${line}\n`)) {
  return function guarded(request, response) {
    if (!SUPPORTED_METHODS.includes(request.method)) return refuse(request, response, 405, METHOD_BODY, { allow: SUPPORTED_METHODS.join(", ") }, write);
    // Same test Next applies to the path (before any decoding), so nothing it would treat as the optimizer gets past.
    if ((request.url ?? "").split("?")[0].startsWith("/_next/image")) return refuse(request, response, 404, NOT_FOUND_BODY, {}, write);
    return listener(request, response);
  };
}

/** Makes every http.createServer(listener) in this process guard its listener. */
export function installRequestGuard(http) {
  const create = http.createServer;
  http.createServer = function createServer(...args) {
    const at = args.findIndex((arg) => typeof arg === "function");
    if (at >= 0) args[at] = guardRequests(args[at]);
    return create.apply(this, args);
  };
}
