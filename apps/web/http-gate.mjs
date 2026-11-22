// The first thing a request meets, in front of Next (M1.3 T7). Next's own runtime builds a fetch
// Request for every request and throws for methods that fetch forbids (TRACE, CONNECT, TRACK),
// before the proxy (src/proxy.ts, the default-deny gate) can run, which gave an anonymous 500 with a
// stack trace in the log on every path. This wrapper answers any method the app doesn't use with a
// JSON 405 and an Allow header, and logs a status only (no stack trace, no method text: it is
// client-chosen). Plain JavaScript on purpose: it is loaded with `node --import` before anything
// else, in the production image, where no TypeScript runs.

export const SUPPORTED_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

const BODY = JSON.stringify({ error: { code: "method_not_allowed", message: "This method is not supported." } });

/** Wraps a Node request listener so unsupported methods are refused before it sees them. */
export function guardMethods(listener, write = (line) => process.stdout.write(`${line}\n`)) {
  return function guarded(request, response) {
    if (SUPPORTED_METHODS.includes(request.method)) return listener(request, response);
    response.writeHead(405, {
      allow: SUPPORTED_METHODS.join(", "),
      "content-type": "application/json",
      "content-length": Buffer.byteLength(BODY),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "same-origin",
      connection: "close",
    });
    response.end(request.method === "HEAD" ? undefined : BODY);
    write(JSON.stringify({ time: new Date().toISOString(), level: "info", msg: "request refused", route: "*", status: 405 }));
  };
}

/** Makes every http.createServer(listener) in this process guard its listener. */
export function installMethodGuard(http) {
  const create = http.createServer;
  http.createServer = function createServer(...args) {
    const at = args.findIndex((arg) => typeof arg === "function");
    if (at >= 0) args[at] = guardMethods(args[at]);
    return create.apply(this, args);
  };
}
