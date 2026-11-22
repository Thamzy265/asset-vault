// Loaded with `node --import ./apps/web/http-gate-preload.mjs apps/web/server.js` (see the Dockerfile).
import http from "node:http";
import { installRequestGuard, selfCheck } from "./http-gate.mjs";

installRequestGuard(http);
// Fail loudly at start if the patch is not in place (reviewer S4) ...
await selfCheck(http);
// ... and if the server Next starts was not built through it: a changed Next that stops calling
// http.createServer would otherwise silently lose the 405 and the optimizer 404.
setTimeout(() => {
  if ((globalThis.__vaultGuardedServers ?? 0) < 1) {
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: "error", msg: "request guard is not in front of the web server" })}\n`);
    process.exit(1);
  }
}, 30_000).unref();
