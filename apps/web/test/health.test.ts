import { createDb, migrateUp, recordHeartbeat } from "@vault/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../packages/db/test/support/fresh-database.ts";
import { getHealth, healthResponse } from "../src/server/health.ts";
import pkg from "../package.json" with { type: "json" };

describe("getHealth", () => {
  const heartbeat = new Date("2026-11-21T10:00:00.000Z");

  it("is 200 ok with version and last worker heartbeat when the database answers", async () => {
    const result = await getHealth({ ping: async () => {}, readHeartbeat: async () => heartbeat, version: "1.2.3" });
    expect(result).toEqual({
      httpStatus: 200,
      body: { status: "ok", db: "ok", version: "1.2.3", workerHeartbeat: "2026-11-21T10:00:00.000Z" },
    });
  });

  it("is 503 with db down when the ping fails, and does not read the heartbeat", async () => {
    let read = false;
    const result = await getHealth({
      ping: async () => { throw new Error("ECONNREFUSED"); },
      readHeartbeat: async () => { read = true; return heartbeat; },
      version: "1.2.3",
    });
    expect(result).toEqual({
      httpStatus: 503,
      body: { status: "error", db: "down", version: "1.2.3", workerHeartbeat: null },
    });
    expect(read).toBe(false);
  });

  it("stays 200 when the heartbeat cannot be read (worker state does not decide health)", async () => {
    const result = await getHealth({
      ping: async () => {},
      readHeartbeat: async () => { throw new Error("boom"); },
      version: "1.2.3",
    });
    expect(result.httpStatus).toBe(200);
    expect(result.body.workerHeartbeat).toBeNull();
  });
});

describe("healthResponse (real Postgres)", () => {
  let url: string;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ url, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());

  it("returns 200 JSON, never cached, with the app version", async () => {
    const db = createDb(url);
    try {
      await migrateUp(db);
      await recordHeartbeat(db, new Date("2026-11-21T10:00:00.000Z"));
      const res = await healthResponse(db);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({
        status: "ok",
        db: "ok",
        version: pkg.version,
        workerHeartbeat: "2026-11-21T10:00:00.000Z",
      });
    } finally {
      await db.destroy();
    }
  });

  it("returns 503 with db down when Postgres is unreachable", async () => {
    const db = createDb("postgres://127.0.0.1:1/unreachable");
    try {
      const res = await healthResponse(db);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: "error", db: "down" });
    } finally {
      await db.destroy();
    }
  });
});
