import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardRequests, installRequestGuard, selfCheck, SUPPORTED_METHODS } from "../http-gate.mjs";

// M1.3 T7, T8: methods the app doesn't use are answered 405 in front of the Next runtime (which throws
// on TRACE and friends before the proxy runs), on every path, with no stack trace logged; /_next/image is a
// 404 that never reaches Next (whose own 404 first tries to create a read-only cache directory).
let server: http.Server;
let port: number;
const reached: string[] = [];
const logged: string[] = [];

beforeAll(async () => {
  server = http.createServer(
    guardRequests(
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

  it.each(["/_next/image?url=%2F&w=64&q=75", "/_next/image", "/_next/image/x", "/_next/imageX"])("%s is a JSON 404 and never reaches Next (the optimizer is off)", async (path) => {
    reached.length = 0;
    for (const method of ["GET", "HEAD", "POST"]) {
      const res = await send(method, path);
      expect(res.status, `${method} ${path}`).toBe(404);
      if (method !== "HEAD") expect(JSON.parse(res.body)).toEqual({ error: { code: "not_found", message: "Not found." } });
    }
    expect(reached).toEqual([]);
  });

  // Reviewer S4: other spellings of the same target. Sent on a raw socket, as a client would, so nothing normalises them first.
  function raw(requestLine: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write(`${requestLine}\r\nHost: x\r\nConnection: close\r\n\r\n`));
      let out = "";
      socket.on("data", (d) => (out += d));
      socket.on("end", () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(out)?.[1]), body: out.split("\r\n\r\n")[1] ?? "" }));
      socket.on("error", reject);
    });
  }

  it.each(["//_next/image?url=%2F&w=64&q=75", "///_next/image", "//_next/image/", "/_next/%69mage?url=%2F", "/%5Fnext/image?url=%2F", "/_next/image%00", "\\_next\\image"])("the optimizer spelled %s never reaches Next", async (path) => {
    reached.length = 0;
    const res = await raw(`GET ${path} HTTP/1.1`);
    expect([400, 404], path).toContain(res.status);
    expect(reached).toEqual([]);
  });

  it.each(["GET http://x/_next/image?url=%2F HTTP/1.1", "GET http://x/ HTTP/1.1", "GET https://x/api/v1/me HTTP/1.1", "POST http://x/api/auth/sign-in HTTP/1.1", "OPTIONS * HTTP/1.1"])("a non-origin-form target (%s) is a 400 and never reaches Next", async (line) => {
    reached.length = 0;
    const res = await raw(line);
    expect(res.status, line).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: { code: "bad_request", message: expect.any(String) } });
    expect(reached).toEqual([]);
  });

  it("an absolute-form TRACE is still a 405 (the method is checked first)", async () => {
    expect((await raw("TRACE http://x/ HTTP/1.1")).status).toBe(405);
  });

  it("other /_next paths go through", async () => {
    reached.length = 0;
    expect((await send("GET", "/_next/static/chunk.js")).status).toBe(200);
    expect((await send("GET", "/_next/images")).status).toBe(404); // startsWith, like Next's own test
    expect(reached).toEqual(["GET /_next/static/chunk.js"]);
  });

  it("logs a status only: no stack trace, no path, no method text", async () => {
    logged.length = 0;
    await send("TRACE", "/secret-looking-path?token=abc");
    expect(logged).toHaveLength(1);
    const line = JSON.parse(logged[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ level: "info", msg: "request refused", status: 405 });
    expect(logged[0]).not.toMatch(/TRACE|secret-looking|token=|\bat \w+ \(|stack/i);
  });

  it("the start-up self-check passes on a patched http module and throws on one that is not patched", async () => {
    const patched = { createServer: http.createServer };
    installRequestGuard(patched);
    await expect(selfCheck(patched)).resolves.toBeUndefined();
    await expect(selfCheck({ createServer: http.createServer })).rejects.toThrow(/request guard/i);
  });

  it("installRequestGuard guards every server later created with http.createServer(listener)", async () => {
    const fake = { createServer: http.createServer };
    installRequestGuard(fake);
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
