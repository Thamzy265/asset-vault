import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

// Stops Postgres of the running stack, checks the failure behaviour, and starts it
// again. The data volume is never touched. Runs alone (see playwright.config.ts).
const run = promisify(execFile);
const project = process.env.COMPOSE_PROJECT_NAME ?? "asset-vault";
const compose = (...args: string[]) => run("docker", ["compose", "-p", project, ...args]);

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await compose("start", "postgres").catch(() => {});
});

test("health is 503 with a clean body while Postgres is down, and recovers without a restart", async ({ request }) => {
  test.setTimeout(120_000);
  expect((await request.get("/api/v1/health")).status()).toBe(200);

  await compose("stop", "postgres");

  await expect.poll(async () => (await request.get("/api/v1/health")).status(), { timeout: 30_000 }).toBe(503);
  const res = await request.get("/api/v1/health");
  expect(res.headers()["cache-control"]).toBe("no-store");
  const text = await res.text();
  expect(JSON.parse(text)).toMatchObject({ status: "error", db: "down", workerHeartbeat: null });
  for (const re of [/postgres(ql)?:\/\//i, /ECONNREFUSED/, /ENOTFOUND/, /getaddrinfo/, /password/i, /\n\s+at /]) {
    expect(text).not.toMatch(re);
  }

  // The pages keep answering while the database is down; the API stays closed (M1.3: no
  // session cookie is refused at once, 401; one that can't be checked would be 503).
  expect((await request.get("/")).status()).toBe(200);
  expect((await request.get("/sign-in")).status()).toBe(200);
  expect([401, 503]).toContain((await request.get("/api/v1/nope")).status());
  const withCookie = await request.get("/api/v1/me", { headers: { cookie: "__Secure-vault.session_token=x.y" } });
  expect([401, 503]).toContain(withCookie.status());

  await compose("start", "postgres");
  await expect.poll(async () => (await request.get("/api/v1/health")).status(), { timeout: 60_000, intervals: [2_000] }).toBe(200);
  expect(await (await request.get("/api/v1/health")).json()).toMatchObject({ status: "ok", db: "ok" });
});
