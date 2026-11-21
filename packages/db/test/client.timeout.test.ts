import { createServer, Socket, type AddressInfo, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, pingDatabase } from "../src/client.ts";
import { freshDatabase } from "./support/fresh-database.ts";

/**
 * A TCP proxy to the test Postgres that can go silent: after `freeze()` it keeps
 * every connection open but forwards nothing, like `docker pause postgres` or a
 * dropped network path. Reviewer finding L2.
 */
function silentProxy(target: { host: string; port: number }) {
  let frozen = false;
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = new Socket();
    upstream.connect(target.port, target.host);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on("error", () => {});
    }
    client.on("data", (d) => void (frozen || upstream.write(d)));
    upstream.on("data", (d) => void (frozen || client.write(d)));
  });
  return {
    listen: () => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))),
    freeze: () => (frozen = true),
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

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
