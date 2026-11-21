import { closeDatabase, createAuthService, openDatabase, type DbHandle } from "@vault/db";
import { getDb as serverDb } from "../src/server/db.ts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TestBrowser } from "../../../packages/db/test/support/auth-client.ts";
import { freshDatabase, type FreshDatabase } from "../../../packages/db/test/support/fresh-database.ts";
import { createLogin } from "../../../packages/db/test/support/logins.ts";
import { migrateUp } from "../../../packages/db/test/support/migrate.ts";
import { secretFromUri, totpCode } from "../../../packages/db/test/support/totp.ts";

// GET /api/v1/me (M1.3): user id, name, role, person id; and the route checks the session
// itself too, so it is safe even if the proxy were bypassed. Plus the /api/v1 request log.
const ORIGIN = "http://127.0.0.1:3000";
const KEY = "me-route-test-key-".padEnd(48, "m");
let fresh: FreshDatabase;
let db: DbHandle;
let route: typeof import("../src/app/api/v1/me/route.ts");
let cookie: string;
let created: Awaited<ReturnType<typeof createLogin>>;
const saved = { ...process.env };

beforeAll(async () => {
  fresh = await freshDatabase();
  const m = openDatabase(fresh.url);
  await migrateUp(m);
  await closeDatabase(m);
  Object.assign(process.env, { DATABASE_URL: fresh.appUrl, APP_URL: ORIGIN, AUTH_ENCRYPTION_KEY: KEY });
  route = await import("../src/app/api/v1/me/route.ts");
  db = openDatabase(fresh.appUrl);
  const auth = createAuthService(db, { appUrl: ORIGIN, encryptionKey: KEY, trustedIpHeader: null });
  created = await createLogin(db, { email: "me@example.org", name: "Mia Example", role: "member" });
  const b = new TestBrowser((r) => auth.handle(r), ORIGIN);
  const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password: "correct horse battery" });
  await b.post("/api/auth/setup/confirm", { code: totpCode(secretFromUri((setup.body.enrolment as { totpUri: string }).totpUri)) });
  cookie = b.cookieHeader();
});
afterAll(async () => {
  process.env = saved;
  await closeDatabase(db);
  await closeDatabase(serverDb()).catch(() => {});
  delete (globalThis as { vaultDb?: unknown; vaultAuth?: unknown }).vaultDb;
  delete (globalThis as { vaultAuth?: unknown }).vaultAuth;
  await fresh.drop();
});

const get = (headers: Record<string, string> = {}) => route.GET(new Request(`${ORIGIN}/api/v1/me`, { headers }));

describe("GET /api/v1/me", () => {
  it("returns exactly id, name, role and personId for the signed-in user, never cached", async () => {
    const res = await get({ cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ id: created.userId, name: "Mia Example", role: "member", personId: created.personId });
  });

  it("is 401 in the API error shape without a session, even called directly (no proxy)", async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
  });

  it("other methods are 405 with Allow (behind the session gate)", async () => {
    const res = await route.POST(new Request(`${ORIGIN}/api/v1/me`, { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("logs one structured line per request: request id, route pattern, method, status, duration; nothing personal (item e)", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      await get({ cookie, "x-request-id": "11111111-2222-4333-8444-555555555555" });
      await get({ "x-request-id": "not-a-uuid<script>" });
    } finally {
      spy.mockRestore();
    }
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.msg === "api request");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ time: expect.any(String), level: "info", msg: "api request", requestId: "11111111-2222-4333-8444-555555555555", route: "/api/v1/me", method: "GET", status: 200, durationMs: expect.any(Number) });
    expect(entries[1]).toMatchObject({ route: "/api/v1/me", status: 401 });
    expect(entries[1]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const text = lines.join("");
    for (const needle of ["me@example.org", "Mia Example", created.personId, "<script>", "session_token"]) expect(text).not.toContain(needle);
  });

  it("a thrown error becomes a JSON 500 and is logged as route, request id and code only", async () => {
    const { apiRoute } = await import("../src/server/api.ts");
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const failing = apiRoute("/api/v1/test", () => {
        throw Object.assign(new Error('duplicate key: Key (email)=(leak@example.org) already exists'), { code: "23505", detail: "Key (email)=(leak@example.org)" });
      });
      const res = await failing(new Request(`${ORIGIN}/api/v1/test`));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: "internal_error", message: expect.any(String) } });
    } finally {
      spy.mockRestore();
    }
    const text = lines.join("");
    expect(text).toContain('"code":"23505"');
    expect(text).not.toContain("leak@example.org");
  });
});
