// Loaded with `node --import ./apps/web/http-gate-preload.mjs apps/web/server.js` (see the Dockerfile).
import http from "node:http";
import { installMethodGuard } from "./http-gate.mjs";

installMethodGuard(http);
