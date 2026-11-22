import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardMethods, installMethodGuard, SUPPORTED_METHODS } from "../http-gate.mjs";

// M1.3 T7: methods the app doesn't use are answered 405 in front of the Next runtime (which throws
// on TRACE and friends before the proxy runs), on every path, with no stack trace logged.
let server: http.Server;
let port: number;
const reached: string[] = [];
const logged: string[] = [];

beforeAll(async () => {
  server = http.createServer(
    guardMethods(
      (request, response) => {
        reached.push(`${request.method} ${request.url}`);
        response.end("next");
      },
      (line) => logged.push(line),
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function send(method: string, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the method gate in front of Next", () => {
  it.each(["TRACE", "CONNECT", "PROPFIND", "PURGE", "LINK", "MKCOL", "SEARCH"])("%s is a JSON 405 with an Allow header, on every kind of path, and never reaches Next", async (method) => {
    reached.length = 0;
    for (const path of ["/", "/api/v1/me", "/api/v1/nothing", "/api/auth/sign-in", "/_next/image?url=%2F&w=64&q=75", "/sign-in"]) {
      if (method === "CONNECT") continue; // CONNECT takes an authority-form target, not a path
      const res = await send(method, path);
      expect(res.status, `${method} ${path}`).toBe(405);
      expect(res.headers.allow).toBe(SUPPORTED_METHODS.join(", "));
      expect(res.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(res.body)).toEqual({ error: { code: "method_not_allowed", message: "This method is not supported." } });
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }
    expect(reached).toEqual([]);
  });

  it.each(SUPPORTED_METHODS)("%s goes through to the app untouched", async (method) => {
    reached.length = 0;
    const res = await send(method, "/api/v1/me");
    expect(res.status).toBe(200);
    expect(reached).toEqual([`${method} /api/v1/me`]);
  });

  it("logs a status only: no stack trace, no path, no method text", async () => {
    logged.length = 0;
    await send("TRACE", "/secret-looking-path?token=abc");
    expect(logged).toHaveLength(1);
    const line = JSON.parse(logged[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ level: "info", msg: "request refused", status: 405 });
    expect(logged[0]).not.toMatch(/TRACE|secret-looking|token=|\bat \w+ \(|stack/i);
  });

  it("installMethodGuard guards every server later created with http.createServer(listener)", async () => {
    const fake = { createServer: http.createServer };
    installMethodGuard(fake);
    const guarded = fake.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => guarded.listen(0, "127.0.0.1", resolve));
    const guardedPort = (guarded.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: guardedPort, method: "TRACE", path: "/" }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end();
    });
    await new Promise<void>((resolve) => guarded.close(() => resolve()));
    expect(status).toBe(405);
  });
});
