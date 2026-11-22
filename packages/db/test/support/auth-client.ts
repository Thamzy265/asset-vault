/**
 * A tiny browser stand-in for auth tests: keeps cookies between requests and
 * sends what a same-origin fetch would (Origin, JSON content type).
 */
export type Handler = (request: Request) => Promise<Response>;

export class TestBrowser {
  readonly cookies = new Map<string, string>();
  private readonly handler: Handler;
  readonly origin: string;
  readonly extraHeaders: Record<string, string>;
  constructor(handler: Handler, origin = "http://127.0.0.1:3000", extraHeaders: Record<string, string> = {}) {
    this.handler = handler;
    this.origin = origin;
    this.extraHeaders = extraHeaders;
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  headers(): Headers {
    const h = new Headers(this.extraHeaders);
    if (this.cookies.size) h.set("cookie", this.cookieHeader());
    h.set("user-agent", "vitest");
    return h;
  }

  absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async post(path: string, body: unknown = {}): Promise<{ status: number; body: Record<string, unknown>; response: Response }> {
    const headers = this.headers();
    headers.set("origin", this.origin);
    headers.set("content-type", "application/json");
    const response = await this.handler(new Request(`${this.origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
    this.absorb(response);
    const text = await response.clone().text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, response };
  }
}
