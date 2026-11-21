import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createDb, createMigrationDb, MIGRATION_TIMEOUTS, pingDatabase, POOL_TIMEOUTS } from "../src/client.ts";
import { freshDatabase } from "./support/fresh-database.ts";
import { silentProxy } from "./support/silent-proxy.ts";

describe("pingDatabase when Postgres stops answering on an open connection (reviewer L2)", () => {
  let drop: () => Promise<void>;
  let proxied: string;
  let proxy: ReturnType<typeof silentProxy>;

  beforeAll(async () => {
    const fresh = await freshDatabase();
    drop = fresh.drop;
    const url = new URL(fresh.url);
    proxy = silentProxy({ host: url.hostname, port: Number(url.port) });
    url.host = `127.0.0.1:${await proxy.listen()}`;
    proxied = url.toString();
  });
  afterAll(async () => {
    await proxy?.close();
    await drop?.();
  });

  it("rejects within ~6 s instead of hanging, so health can answer 503", async () => {
    const db = createDb(proxied, { maxConnections: 1 });
    try {
      await pingDatabase(db); // opens the pooled connection while Postgres answers
      proxy.freeze();

      const started = Date.now();
      const outcome = await Promise.race([
        pingDatabase(db).then(() => "resolved", () => "rejected"),
        new Promise<string>((resolve) => setTimeout(() => resolve("still pending after 8 s"), 8_000)),
      ]);
      expect(outcome).toBe("rejected");
      expect(Date.now() - started).toBeLessThan(6_500);
    } finally {
      // Don't wait on a graceful pool shutdown through a silent proxy.
      void db.destroy().catch(() => {});
    }
  }, 15_000);
});

describe("timeouts: Postgres cancels a slow statement before the client gives up (review N1)", () => {
  let url: string;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ url, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());

  it("keeps statement_timeout (4 s) below the client query_timeout (5 s)", () => {
    expect(POOL_TIMEOUTS).toEqual({ statementMs: 4_000, queryMs: 5_000 });
  });

  it("a query longer than statement_timeout is cancelled by Postgres, and the next query on a 1-connection pool answers at once", async () => {
    const db = createDb(url, { maxConnections: 1 });
    try {
      expect((await sql<{ statement_timeout: string }>`show statement_timeout`.execute(db)).rows[0]?.statement_timeout).toBe("4s");

      const started = Date.now();
      const slow = await sql`select pg_sleep(8)`.execute(db).then(
        () => ({ code: "resolved" }),
        (error: { code?: string }) => ({ code: error.code }),
      );
      expect(slow.code).toBe("57014"); // query_canceled: Postgres stopped it, so the connection is free
      expect(Date.now() - started).toBeLessThan(4_900);

      const next = Date.now();
      await sql`select 1`.execute(db);
      expect(Date.now() - next).toBeLessThan(1_000);
    } finally {
      await db.destroy();
    }
  }, 20_000);

  it("the migration connection allows 5 min statements, waits at most 10 s for a lock, and its client timeout is above both", async () => {
    expect(MIGRATION_TIMEOUTS.statementMs).toBe(300_000);
    expect(MIGRATION_TIMEOUTS.lockMs).toBe(10_000);
    expect(MIGRATION_TIMEOUTS.queryMs).toBeGreaterThan(MIGRATION_TIMEOUTS.statementMs);
    const db = createMigrationDb(url);
    try {
      const { rows } = await sql<{ s: string; l: string }>`
        select current_setting('statement_timeout') as s, current_setting('lock_timeout') as l`.execute(db);
      expect(rows[0]).toEqual({ s: "5min", l: "10s" });
    } finally {
      await db.destroy();
    }
  });
});
