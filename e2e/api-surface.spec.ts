import { expect, test } from "@playwright/test";

const SENSITIVE = [/postgres(ql)?:\/\//i, /POSTGRES_PASSWORD/, /DATABASE_URL/, /ECONNREFUSED/, /ENOTFOUND/, /getaddrinfo/, /node_modules/, /\n\s+at /, /Error:/];
const PATH = "/api/v1/health";

function expectClean(text: string) {
  for (const re of SENSITIVE) expect(text, `must not match ${re}`).not.toMatch(re);
}

test.describe("health endpoint abuse and edge cases", () => {
  test("200 body is exactly the documented fields and leaks nothing", async ({ request }) => {
    const res = await request.get(PATH);
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(res.headers()["x-powered-by"]).toBeUndefined();
    const text = await res.text();
    expectClean(text);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["db", "status", "version", "workerHeartbeat"]);
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    test(`${method} is refused with 405 and no body details`, async ({ request }) => {
      const res = await request.fetch(PATH, { method, data: { a: 1 } });
      expect(res.status()).toBe(405);
      expectClean(await res.text());
    });
  }

  // BUG M1.1-T2 (low): the 405 carries no Allow header (RFC 9110 requires one).
  // test.fail keeps the suite green until the developer fixes it; remove it then.
  test.fail("405 names the allowed methods in an Allow header", async ({ request }) => {
    const res = await request.fetch(PATH, { method: "POST" });
    expect(res.headers()["allow"]).toMatch(/GET/);
  });

  test("OPTIONS and HEAD behave: OPTIONS lists GET, HEAD has no body but the same status", async ({ request }) => {
    const options = await request.fetch(PATH, { method: "OPTIONS" });
    expect(options.status()).toBe(204);
    expect(options.headers()["allow"]).toContain("GET");
    const head = await request.fetch(PATH, { method: "HEAD" });
    expect(head.status()).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("a trailing slash redirects to the canonical path (no 5xx)", async ({ request }) => {
    const res = await request.get(`${PATH}/`, { maxRedirects: 0 });
    expect(res.status()).toBe(308);
    expect(res.headers()["location"]).toBe(PATH);
  });

  test("wrong case, unknown siblings and traversal attempts are 404 without a stack trace", async ({ request }) => {
    for (const p of ["/api/v1/Health", "/api/v1/HEALTH", "/api/v1/nope", "/api/v1/health/extra", "/api/health", "/api/v1/health%2f..%2f..%2fetc%2fpasswd", "/api/v1/health/%2e%2e/%2e%2e/.env"]) {
      const res = await request.get(p, { maxRedirects: 0 });
      expect([404, 308], p).toContain(res.status());
      expectClean(await res.text());
    }
  });

  test("odd query strings are ignored and cannot change the answer", async ({ request }) => {
    const queries = [
      "?x=%00",
      "?a[]=1&a[]=2",
      "?url=postgres://a:b@c/d",
      `?${"a=b&".repeat(500)}`,
      "?__proto__[polluted]=1&constructor[prototype][x]=1",
      "?status=error&db=down",
      "?%E0%A4%A",
    ];
    for (const q of queries) {
      const res = await request.get(`${PATH}${q}`);
      expect(res.status(), q).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ status: "ok", db: "ok" });
      expectClean(JSON.stringify(body));
    }
  });

  test("odd request headers do not change the answer or get reflected", async ({ request }) => {
    const res = await request.get(PATH, {
      headers: {
        "x-forwarded-host": "evil.example",
        "x-forwarded-for": "10.0.0.1, 127.0.0.1",
        "x-middleware-subrequest": "middleware",
        accept: "text/html",
        "accept-language": "xx-YY,zz;q=0.1",
        authorization: "Bearer not-a-token",
        cookie: "a=b; c=d",
        origin: "https://evil.example",
        "x-test-injection": "<script>alert(1)</script>",
      },
    });
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("<script>");
    expect(res.headers()["access-control-allow-origin"]).toBeUndefined();
  });

  test("a huge header is rejected by the server rather than crashing it, and health still answers afterwards", async ({ request }) => {
    const res = await request.get(PATH, { headers: { "x-big": "a".repeat(64 * 1024) }, failOnStatusCode: false }).catch(() => null);
    if (res) expect([200, 400, 431]).toContain(res.status());
    const after = await request.get(PATH);
    expect(after.status()).toBe(200);
  });

  test("a large POST body is refused with 405 and the server stays up", async ({ request }) => {
    const res = await request.post(PATH, { data: "x".repeat(2 * 1024 * 1024), headers: { "content-type": "text/plain" } });
    expect(res.status()).toBe(405);
    expect((await request.get(PATH)).status()).toBe(200);
  });

  test("a burst of concurrent requests all succeed (pool is not exhausted)", async ({ request }) => {
    const results = await Promise.all(Array.from({ length: 60 }, () => request.get(PATH)));
    expect(results.map((r) => r.status())).toEqual(Array(60).fill(200));
  });

  test("the worker heartbeat shows up in health within two minutes and is recent", async ({ request }) => {
    test.setTimeout(150_000);
    await expect
      .poll(async () => (await (await request.get(PATH)).json()).workerHeartbeat, { timeout: 130_000, intervals: [5_000] })
      .not.toBeNull();
    const { workerHeartbeat } = await (await request.get(PATH)).json();
    expect(workerHeartbeat).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const age = Date.now() - new Date(workerHeartbeat).getTime();
    expect(age).toBeLessThan(150_000);
    expect(age).toBeGreaterThan(-5_000);
  });

  test("the home page is a normal HTML page and sets no cookies or powered-by header", async ({ request }) => {
    const res = await request.get("/");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
    expect(res.headers()["x-powered-by"]).toBeUndefined();
    expect(res.headers()["set-cookie"]).toBeUndefined();
  });
});
