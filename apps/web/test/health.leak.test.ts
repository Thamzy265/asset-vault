import { closeDatabase, openDatabase } from "@vault/db";
import { afterAll, describe, expect, it } from "vitest";
import { getHealth, healthResponse } from "../src/server/health.ts";

const PASSWORD = "hunter2secretpw";
const HOST = "db-internal.example.invalid";
const URL_WITH_SECRET = `postgres://vault:${PASSWORD}@${HOST}:5432/vault`;

function assertNothingSensitive(text: string): void {
  for (const needle of [PASSWORD, HOST, "postgres://", "ECONNREFUSED", "ENOTFOUND", "getaddrinfo", "stack", "    at ", "node_modules", "Error:"]) {
    expect(text, `response must not contain "${needle}"`).not.toContain(needle);
  }
}

describe("health response does not leak (tester, abuse case: read secrets via health)", () => {
  it("503 body is a fixed allowlist of fields even when the DB error message contains the URL", async () => {
    const result = await getHealth({
      ping: async () => {
        throw new Error(`connect failed for ${URL_WITH_SECRET}`, { cause: new Error(URL_WITH_SECRET) });
      },
      readHeartbeat: async () => new Date(),
      version: "1.2.3",
      readSchemaVersion: async () => "0003_audit_log",
      expectedSchemaVersion: "0003_audit_log",
    });
    expect(result.httpStatus).toBe(503);
    expect(Object.keys(result.body).sort()).toEqual(["db", "schema", "status", "version", "workerHeartbeat"]);
    assertNothingSensitive(JSON.stringify(result.body));
  });

  it("200 body is the same allowlist when the heartbeat read fails with a URL in its message", async () => {
    const result = await getHealth({
      ping: async () => {},
      readHeartbeat: async () => {
        throw new Error(URL_WITH_SECRET);
      },
      version: "1.2.3",
      readSchemaVersion: async () => "0003_audit_log",
      expectedSchemaVersion: "0003_audit_log",
    });
    expect(result.httpStatus).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(["db", "schema", "status", "version", "workerHeartbeat"]);
    assertNothingSensitive(JSON.stringify(result.body));
  });

  it("503 never carries a stale heartbeat or detail, even if one could be read", async () => {
    const result = await getHealth({
      ping: async () => {
        throw new Error("x");
      },
      readHeartbeat: async () => new Date("2026-11-21T10:00:00.000Z"),
      version: "1.2.3",
      readSchemaVersion: async () => "0003_audit_log",
      expectedSchemaVersion: "0003_audit_log",
    });
    expect(result.body.workerHeartbeat).toBeNull();
  });

  describe("real pool against an unreachable host with a password in the URL", () => {
    const dbs: ReturnType<typeof openDatabase>[] = [];
    afterAll(async () => {
      await Promise.all(dbs.map((d) => closeDatabase(d)));
    });

    it("503 response body and headers contain nothing from the connection string or the driver error", async () => {
      const db = openDatabase(URL_WITH_SECRET);
      dbs.push(db);
      const res = await healthResponse(db);
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toContain("application/json");
      const headers = JSON.stringify([...res.headers.entries()]);
      const text = await res.text();
      assertNothingSensitive(text);
      assertNothingSensitive(headers);
      expect(JSON.parse(text)).toEqual({ status: "error", db: "down", version: expect.any(String), schema: { expected: expect.any(String), applied: null }, workerHeartbeat: null });
    });

    it("503 for a URL pg cannot parse (TypeError path) is the same clean body", async () => {
      const db = openDatabase(`postgres://vault:${PASSWORD}@${HOST}:notaport/vault`);
      dbs.push(db);
      const res = await healthResponse(db);
      expect(res.status).toBe(503);
      assertNothingSensitive(await res.text());
    });
  });
});
