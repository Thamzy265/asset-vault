import net from "node:net";

/**
 * One HTTP/1.1 request written byte for byte on a socket, so the server sees exactly this request
 * line: no client normalises `..`, `//`, `%2F`, `;` or odd methods first (fetch and Playwright both do).
 */
export type RawResponse = { status: number; headers: Map<string, string[]>; body: string; location: string | null };

const port = Number(process.env.WEB_PORT ?? "3000");

export function rawRequest(path: string, options: { method?: string; headers?: Record<string, string>; body?: string; maxBody?: number } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    const headerLines = Object.entries({ host: `127.0.0.1:${port}`, connection: "close", ...options.headers }).map(([k, v]) => `${k}: ${v}`);
    if (options.body !== undefined) headerLines.push(`content-length: ${Buffer.byteLength(options.body)}`);
    socket.on("connect", () => socket.write(`${options.method ?? "GET"} ${path} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n${options.body ?? ""}`));
    socket.on("data", (d) => chunks.push(d));
    socket.on("error", reject);
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      const head = (split < 0 ? text : text.slice(0, split)).split("\r\n");
      const headers = new Map<string, string[]>();
      for (const line of head.slice(1)) {
        const colon = line.indexOf(":");
        if (colon < 1) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1).trim()]);
      }
      let body = split < 0 ? "" : text.slice(split + 4);
      if (headers.get("transfer-encoding")?.[0]?.toLowerCase() === "chunked") body = dechunk(body);
      resolve({
        status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? "")?.[1] ?? 0),
        headers,
        body: body.slice(0, options.maxBody ?? 65_536),
        location: headers.get("location")?.[0] ?? null,
      });
    });
    socket.setTimeout(15_000, () => {
      socket.destroy();
      reject(new Error(`timeout: ${options.method ?? "GET"} ${path.slice(0, 80)}`));
    });
  });
}

/** The body of a chunked response, chunks joined (sizes are in bytes; the tests only read ASCII/JSON, so characters stand in). */
function dechunk(raw: string): string {
  let out = "";
  let rest = raw;
  for (;;) {
    const eol = rest.indexOf("\r\n");
    if (eol < 0) return out;
    const size = parseInt(rest.slice(0, eol), 16);
    if (!Number.isFinite(size) || size === 0) return out;
    out += rest.slice(eol + 2, eol + 2 + size);
    rest = rest.slice(eol + 2 + size + 2);
  }
}
