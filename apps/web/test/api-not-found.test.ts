import { describe, expect, it } from "vitest";
import * as route from "../src/app/api/v1/[[...path]]/route.ts";

// M1.1-T3 (ADR 0003, API-first): every /api/v1/* response is JSON, errors included.
// Unknown /api/v1 paths fall through to this catch-all route.
const METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] as const;

describe("unknown /api/v1/* paths answer with a JSON 404", () => {
  it("handles every HTTP method Next routes, so none falls back to an HTML page or an auto OPTIONS 204", () => {
    for (const method of METHODS) expect(typeof route[method], method).toBe("function");
  });

  it.each(METHODS)("%s returns 404 with the stable error shape", async (method) => {
    const res = route[method]();
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("takes no request, so nothing from the path or query can be echoed into the body", () => {
    for (const method of METHODS) expect(route[method].length, method).toBe(0);
  });

  it("is never statically cached", () => {
    expect(route.dynamic).toBe("force-dynamic");
  });
});
