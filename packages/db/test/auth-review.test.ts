import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogin } from "../src/auth/logins.ts";
import { createAuthService, type AuthService } from "../src/auth/service.ts";
import { createDb } from "../src/client.ts";
import { migrateUp } from "../src/migrate.ts";
import type { Database } from "../src/schema.ts";
import { TestBrowser } from "./support/auth-client.ts";
import { freshDatabase, type FreshDatabase } from "./support/fresh-database.ts";
import { forgetUsedCodes, secretFromUri, totpCode } from "./support/totp.ts";

// Reviewer round for M1.3 (S1, S2, S3, S5, S6): concurrency and failure behaviour of the auth service
// against a real database as vault_app.
const KEY = "review-encryption-key-".padEnd(48, "r");
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery";

let fresh: FreshDatabase;
let migrator: Kysely<Database>;
let app: Kysely<Database>;
let auth: AuthService;
let authIp: AuthService;

beforeAll(async () => {
  fresh = await freshDatabase();
  migrator = createDb(fresh.url);
  await migrateUp(migrator);
  app = createDb(fresh.appUrl, { maxConnections: 40 });
  auth = createAuthService(app, { appUrl: ORIGIN, encryptionKey: KEY, trustedIpHeader: null }, { log: () => {} });
  authIp = createAuthService(app, { appUrl: ORIGIN, encryptionKey: KEY, trustedIpHeader: "cf-connecting-ip" }, { log: () => {} });
});
afterAll(async () => {
  await app?.destroy();
  await migrator?.destroy();
  await fresh?.drop();
});
beforeEach(async () => {
  await migrator.deleteFrom("auth_sign_in_failures").execute();
});

const browser = (service: AuthService = auth, headers: Record<string, string> = {}) => new TestBrowser((r) => service.handle(r), ORIGIN, headers);
const email = () => `review-${randomUUID().slice(0, 8)}@example.org`;
const tally = (statuses: number[]) => statuses.reduce<Record<number, number>>((n, s) => ({ ...n, [s]: (n[s] ?? 0) + 1 }), {});

type Enrolment = { totpUri: string };
async function enrolled() {
  const address = email();
  const created = await createLogin(app, { email: address, name: "Review", role: "member" });
  const b = browser();
  const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
  const secret = secretFromUri((setup.body.enrolment as Enrolment).totpUri);
  expect((await b.post("/api/auth/setup/confirm", { code: totpCode(secret) })).status).toBe(200);
  return { address, created, secret, browser: b };
}

describe("S1: the sign-in limits hold under parallel requests", () => {
  it("30 parallel wrong passwords for one email: at most 5 reach the password check, the rest are 429", async () => {
    const address = email();
    await createLogin(app, { email: address, name: "Probe", role: "member" });
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => browser().post("/api/auth/sign-in", { email: address, password: `wrong password number ${i}` })));
    const n = tally(results.map((r) => r.status));
    expect(n[401] ?? 0, JSON.stringify(n)).toBeLessThanOrEqual(5);
    expect(n[429] ?? 0, JSON.stringify(n)).toBeGreaterThanOrEqual(25);
    expect((n[401] ?? 0) + (n[429] ?? 0)).toBe(30);
    expect(await migrator.selectFrom("auth_sign_in_failures").select("id").execute()).toHaveLength(n[401]!);
  });

  it("30 parallel wrong passwords for 30 emails from one network: at most 20 reach the password check", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => browser(authIp, { "cf-connecting-ip": "203.0.113.9" }).post("/api/auth/sign-in", { email: email(), password: "wrong password here" })));
    const n = tally(results.map((r) => r.status));
    expect(n[401] ?? 0, JSON.stringify(n)).toBeLessThanOrEqual(20);
    expect(n[429] ?? 0, JSON.stringify(n)).toBeGreaterThanOrEqual(10);
  });

  it("right passwords never count against the limits, however many in a row (only attempts in flight at the same moment do)", async () => {
    const person = await enrolled();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await browser().post("/api/auth/sign-in", { email: person.address, password: PASSWORD })).status);
    expect(tally(statuses)).toEqual({ 200: 12 });
    expect(await migrator.selectFrom("auth_sign_in_failures").select("id").execute()).toEqual([]);
  });

  it("a wrong password still counts after the claim, and the 6th try is a 429 with the time left", async () => {
    const address = email();
    await createLogin(app, { email: address, name: "Seq", role: "member" });
    for (let i = 0; i < 5; i++) expect((await browser().post("/api/auth/sign-in", { email: address, password: "wrong password here" })).status).toBe(401);
    const sixth = await browser().post("/api/auth/sign-in", { email: address, password: "wrong password here" });
    expect(sixth.status).toBe(429);
    expect(Number(sixth.response.headers.get("retry-after"))).toBeGreaterThan(14 * 60);
  });
});

describe("S2: the setup link cannot be used to resume once enrolment is confirmed", () => {
  async function confirmedWithLinkLeft() {
    const created = await createLogin(app, { email: email(), name: "Probe", role: "member" });
    const b = browser();
    const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
    const secret = secretFromUri((setup.body.enrolment as Enrolment).totpUri);
    const row = await migrator.selectFrom("auth_setup_tokens").selectAll().where("user_id", "=", created.userId).executeTakeFirstOrThrow();
    expect((await b.post("/api/auth/setup/confirm", { code: totpCode(secret) })).status).toBe(200);
    await migrator.insertInto("auth_setup_tokens").values(row).execute(); // the window between verify and the token delete
    return { created, secret, b };
  }

  it("resume and password with a link that is still there after confirm are refused, and mint no session", async () => {
    const { created, secret, b } = await confirmedWithLinkLeft();
    const c = browser();
    const resumed = await c.post("/api/auth/setup/resume", { token: created.setupToken });
    expect(resumed.status).toBe(410);
    expect(c.cookies.size).toBe(0);
    expect((await auth.session(c.headers())).status).toBe("signed-out");
    const pw = await browser().post("/api/auth/setup/password", { token: created.setupToken, password: "another long passphrase" });
    expect(pw.status).toBe(410);
    // The owner's enrolment is untouched: the secret still signs them in.
    expect((await auth.session(b.headers())).status).toBe("signed-in");
    expect((await migrator.selectFrom("auth_two_factors").select("verified").where("user_id", "=", created.userId).executeTakeFirstOrThrow()).verified).toBe(true);
    const d = browser();
    await d.post("/api/auth/sign-in", { email: (await migrator.selectFrom("auth_users").select("email").where("id", "=", created.userId).executeTakeFirstOrThrow()).email, password: PASSWORD });
    await forgetUsedCodes(migrator);
    expect((await d.post("/api/auth/two-factor/totp", { code: totpCode(secret, Date.now(), 1) })).status).toBe(200);
  });

  it("a session of a user whose 2FA flag is on but whose enrolment is not verified is not signed in", async () => {
    const created = await createLogin(app, { email: email(), name: "Odd", role: "member" });
    const b = browser();
    await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
    await migrator.updateTable("auth_users").set({ two_factor_enabled: true }).where("id", "=", created.userId).execute();
    expect((await auth.session(b.headers())).status).toBe("two-factor-required");
  });

  it("confirm racing resume: the resumer never ends up fully signed in, and the owner can still sign in", async () => {
    let fullSessions = 0;
    for (let i = 0; i < 12; i++) {
      const created = await createLogin(app, { email: email(), name: "Race", role: "member" });
      const b = browser();
      const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
      const secret = secretFromUri((setup.body.enrolment as Enrolment).totpUri);
      const c = browser();
      const [conf] = await Promise.all([b.post("/api/auth/setup/confirm", { code: totpCode(secret) }), new Promise((r) => setTimeout(r, i)).then(() => c.post("/api/auth/setup/resume", { token: created.setupToken }))]);
      if ((await auth.session(c.headers())).status === "signed-in") fullSessions++;
      // Either the confirm won (the owner is enrolled with the secret they saw) or the resume replaced it first (the confirm then fails).
      if (conf.status === 200) expect((await migrator.selectFrom("auth_two_factors").select("verified").where("user_id", "=", created.userId).executeTakeFirstOrThrow()).verified).toBe(true);
    }
    expect(fullSessions).toBe(0);
  });
});

describe("S3: sign-out when the session can't be checked", () => {
  it("sign-out-everywhere and sign-out with the database unreachable are 5xx, never a 401 or a claimed sign-out; the sessions stay", async () => {
    const person = await enrolled();
    const bad = new URL(fresh.appUrl);
    bad.password = "wrong-password-for-test";
    const deadDb = createDb(bad.toString());
    const logged: string[] = [];
    const dead = createAuthService(deadDb, { appUrl: ORIGIN, encryptionKey: KEY, trustedIpHeader: null }, { log: (_l, m) => void logged.push(m) });
    for (const path of ["/api/auth/sign-out-everywhere", "/api/auth/sign-out"]) {
      const d = new TestBrowser((r) => dead.handle(r), ORIGIN);
      for (const [k, v] of person.browser.cookies) d.cookies.set(k, v);
      const res = await d.post(path);
      expect(res.status, path).toBe(500);
      expect(res.body, path).toEqual({ error: { code: "internal_error", message: expect.any(String) } });
      expect(res.response.headers.getSetCookie(), `${path} must not clear the cookies`).toEqual([]);
    }
    expect(await migrator.selectFrom("auth_sessions").select("id").where("user_id", "=", person.created.userId).execute()).toHaveLength(1);
    expect((await auth.session(person.browser.headers())).status).toBe("signed-in");
    await deadDb.destroy();
  });

  it("sign-out-everywhere without a session is still a 401 (the session is truly gone)", async () => {
    const res = await browser().post("/api/auth/sign-out-everywhere");
    expect(res.status).toBe(401);
  });
});

describe("S5: the body limit is enforced while reading, not after", () => {
  function chunked(totalBytes: number, chunkBytes = 1024) {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) return controller.close();
        sent += chunkBytes;
        controller.enqueue(new TextEncoder().encode("a".repeat(chunkBytes)));
      },
    });
    return { stream, sent: () => sent };
  }

  it("a chunked body over 8 KB is a 413 and the stream is not read to the end", async () => {
    const body = chunked(50 * 1024 * 1024);
    const request = new Request(`${ORIGIN}/api/auth/sign-in`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: body.stream,
      duplex: "half",
    } as RequestInit);
    const res = await auth.handle(request);
    expect(res.status).toBe(413);
    expect(body.sent(), "the handler stopped reading soon after 8 KB").toBeLessThan(64 * 1024);
  });

  it("a chunked body under 8 KB still works", async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ token: "x".repeat(43) }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload.slice(0, 10));
        controller.enqueue(payload.slice(10));
        controller.close();
      },
    });
    const res = await auth.handle(new Request(`${ORIGIN}/api/auth/setup/check`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit));
    expect(res.status).toBe(410);
  });
});

describe("S6: re-issuing a setup link is audited", () => {
  it("writes one update row for the user, field names only, no actor", async () => {
    const person = await enrolled();
    const before = Number((await migrator.selectFrom("audit_log").select(sql<string>`coalesce(max(id), 0)`.as("m")).executeTakeFirstOrThrow()).m);
    await createLogin(app, { email: person.address, name: "Review", role: "member" });
    const rows = await migrator.selectFrom("audit_log").select(["action", "entity_type", "entity_id", "actor_user_id", "details"]).where("id", ">", before as never).orderBy("id").execute();
    expect(rows).toEqual([{ action: "update", entity_type: "user", entity_id: person.created.userId, actor_user_id: null, details: { fields: ["two_factor", "sessions", "setup_link"] } }]);
  });

  it("a first-time create is not an update row", async () => {
    const created = await createLogin(app, { email: email(), name: "New", role: "member" });
    const rows = await migrator.selectFrom("audit_log").select("action").where("entity_id", "=", created.userId).execute();
    expect(rows.map((r) => r.action)).toEqual(["create"]);
  });
});
