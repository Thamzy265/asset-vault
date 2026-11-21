import { createServer, Socket, type AddressInfo, type Server } from "node:net";

/**
 * A TCP proxy to the test Postgres that can go silent: after `freeze()` it keeps
 * every connection open but forwards nothing, like `docker pause postgres` or a
 * dropped network path. Reviewer findings L2 (M1.1) and L4 (M1.2).
 */
export function silentProxy(target: { host: string; port: number }) {
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

/** `url` with its host and port replaced by the proxy's. */
export async function throughSilentProxy(url: string): Promise<{ url: string; proxy: ReturnType<typeof silentProxy> }> {
  const target = new URL(url);
  const proxy = silentProxy({ host: target.hostname, port: Number(target.port) });
  target.host = `127.0.0.1:${await proxy.listen()}`;
  return { url: target.toString(), proxy };
}
