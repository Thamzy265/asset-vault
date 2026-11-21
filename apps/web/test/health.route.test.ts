import { closeDatabase } from "@vault/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as route from "../src/app/api/v1/health/route.ts";
import { getDb } from "../src/server/db.ts";

const PASSWORD = "routepw12345";

describe("GET /api/v1/health route module (tester)", () => {
  const saved = process.env.DATABASE_URL;
  beforeAll(() => {
    process.env.DATABASE_URL = `postgres://vault:${PASSWORD}@127.0.0.1:1/vault`;
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
    await closeDatabase(getDb());
    delete (globalThis as { vaultDb?: unknown }).vaultDb;
  });

  it("exports GET and explicit handlers for every other method Next routes (HEAD comes from GET)", () => {
    const exported = Object.keys(route).sort();
    expect(exported).toEqual(["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT", "dynamic"]);
  });

  // M1.1-T2: Next's automatic 405 has no Allow header (RFC 9110 requires one).
  // M1.1-T3: the 405 body uses the same JSON error shape as the /api/v1 404.
  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "%s answers 405 with Allow: GET, HEAD, OPTIONS and the JSON error shape",
    async (method) => {
      const res = route[method]();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: { code: "method_not_allowed", message: expect.any(String) } });
    },
  );

  it("OPTIONS answers 204 with the same Allow header and no body", async () => {
    const res = route.OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect(await res.text()).toBe("");
  });

  it("is never statically cached", () => {
    expect(route.dynamic).toBe("force-dynamic");
  });

  it("ignores the request: a GET with a hostile query string yields the same clean 503 when the DB is down", async () => {
    const res = await route.GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain(PASSWORD);
    expect(JSON.parse(text)).toMatchObject({ status: "error", db: "down" });
  });
});
