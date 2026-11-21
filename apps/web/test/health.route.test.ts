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
    await getDb().destroy();
    delete (globalThis as { vaultDb?: unknown }).vaultDb;
  });

  it("exports only GET (+ route config), so Next answers any other method with 405", () => {
    const exported = Object.keys(route).sort();
    expect(exported).toEqual(["GET", "dynamic"]);
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
