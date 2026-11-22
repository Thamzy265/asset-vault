import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogin, deactivateLogin } from "../src/auth/logins.ts";
import { accountKey } from "../src/auth/rate-limit.ts";
import { createAuthService, type AuthService } from "../src/auth/service.ts";
import { createDb } from "../src/client.ts";
import { migrateUp } from "../src/migrate.ts";
import type { Database } from "../src/schema.ts";
import { TestBrowser } from "./support/auth-client.ts";
import { freshDatabase, type FreshDatabase } from "./support/fresh-database.ts";
import { secretFromUri, totpCode } from "./support/totp.ts";

// Independent tester round for M1.3 (sign-in with mandatory 2FA): abuse cases and edge cases
// from docs/design/m1-3-sign-in.md ("Trust boundaries and abuse cases", "Failure plan") against
// the real auth service and a real database as vault_app. The developer's own tests are in
// auth-service.test.ts; these probe the places that file does not.
//
// Tests whose title starts with "BUG:" fail today and are the repro for a defect in the report.
// Tests whose title ends with "(accepted until M1.4)" or "(spec question)" lock in behaviour the
// design note accepts or leaves open, so a change to it is a deliberate decision.
const KEY = "tester-encryption-key-".padEnd(48, "t");
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery";

let fresh: FreshDatabase;
let migrator: Kysely<Database>;
let app: Kysely<Database>;
let auth: AuthService;
let authIp: AuthService;
let logged: string[];
const secrets: string[] = []; // every password, code and token a test used, for the log scan at the end

beforeAll(async () => {
  fresh = await freshDatabase();
  migrator = createDb(fresh.url);
  await migrateUp(migrator);
  app = createDb(fresh.appUrl);
  logged = [];
  const log = (level: string, msg: string, fields?: Record<string, unknown>) => void logged.push(JSON.stringify({ level, msg, ...fields }));
  auth = createAuthService(app, { appUrl: ORIGIN, encryptionKey: KEY, trustedIpHeader: null }, { log });
  authIp = createAuthService(app, { appUrl: ORIGIN, encryptionKey: KEY, trustedIpHeader: "cf-connecting-ip" }, { log });
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
const email = () => `abuse-${randomUUID().slice(0, 8)}@example.org`;
const errCode = (res: { body: Record<string, unknown> }) => (res.body.error as { code?: string } | undefined)?.code;
const wrongCodeFor = (secret: string) => (totpCode(secret) === "000000" ? "111111" : "000000");

type Enrolment = { totpUri: string; secret: string; backupCodes: string[] };
type Person = { email: string; userId: string; secret: string; backupCodes: string[]; browser: TestBrowser };

/** pnpm user:create, then the person finishes the setup link. Returns a browser that is fully signed in. */
async function enrolledUser(password = PASSWORD, service: AuthService = auth): Promise<Person> {
  secrets.push(password);
  const address = email();
  const created = await createLogin(app, { email: address, name: "Test Person", role: "member" });
  const b = browser(service);
  const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password });
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  const enrolment = setup.body.enrolment as Enrolment;
  const secret = secretFromUri(enrolment.totpUri);
  secrets.push(secret, ...enrolment.backupCodes);
  expect((await b.post("/api/auth/setup/confirm", { code: totpCode(secret) })).status).toBe(200);
  return { email: address, userId: created.userId, secret, backupCodes: enrolment.backupCodes, browser: b };
}

/** Password step done, authenticator step abandoned (a password-only session). */
async function passwordOnlyUser() {
  const address = email();
  const created = await createLogin(app, { email: address, name: "Half Done", role: "member" });
  const b = browser();
  const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
  expect(setup.status).toBe(200);
  return { email: address, userId: created.userId, browser: b };
}

async function signInFully(person: Person, service: AuthService = auth, headers: Record<string, string> = {}): Promise<TestBrowser> {
  const b = browser(service, headers);
  expect((await b.post("/api/auth/sign-in", { email: person.email, password: PASSWORD })).status).toBe(200);
  const res = await b.post("/api/auth/two-factor/totp", { code: totpCode(person.secret, Date.now(), 1) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return b;
}

/** Audit rows of one action written after `sinceId` (the audit log is append-only, so tests scope by id). */
const auditFor = (action: string, sinceId = 0) =>
  migrator.selectFrom("audit_log").select(["actor_user_id", "ip_prefix", "action"]).where("action", "=", action as never).where("id", ">", sinceId as never).orderBy("id").execute();
const auditMark = async () => Number((await migrator.selectFrom("audit_log").select(sql<string>`coalesce(max(id), 0)`.as("m")).executeTakeFirstOrThrow()).m);
const count = async (table: keyof Database & string) => Number((await migrator.selectFrom(table).select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow()).n);

// ---------------------------------------------------------------------------------------------
describe("setup link: expiry, tampering, reuse, races", () => {
  it("is valid up to the 24 h mark and refused the second after it", async () => {
    const created = await createLogin(app, { email: email(), name: "Edge", role: "member" });
    const b = browser();
    await migrator.updateTable("auth_setup_tokens").set({ expires_at: sql`now() + interval '3 seconds'` }).where("user_id", "=", created.userId).execute();
    expect((await b.post("/api/auth/setup/check", { token: created.setupToken })).status).toBe(200);
    await migrator.updateTable("auth_setup_tokens").set({ expires_at: sql`now() - interval '1 second'` }).where("user_id", "=", created.userId).execute();
    expect((await b.post("/api/auth/setup/check", { token: created.setupToken })).status).toBe(410);
    const used = await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
    expect(used.status).toBe(410);
    expect(errCode(used)).toBe("link_invalid");
    expect(b.cookies.size, "an expired link must not leave any cookie").toBe(0);
    expect(await migrator.selectFrom("auth_accounts").select("id").where("user_id", "=", created.userId).execute()).toEqual([]);
  });

  it("is issued with a 24 h life, not a longer one", async () => {
    const created = await createLogin(app, { email: email(), name: "Edge", role: "member" });
    const row = await migrator
      .selectFrom("auth_setup_tokens")
      .select(sql<number>`extract(epoch from (expires_at - now()))`.as("left"))
      .where("user_id", "=", created.userId)
      .executeTakeFirstOrThrow();
    expect(Number(row.left)).toBeGreaterThan(24 * 3600 - 60);
    expect(Number(row.left)).toBeLessThanOrEqual(24 * 3600);
  });

  it("a tampered, truncated, re-cased, padded or mistyped token is refused with the same answer as an unknown one", async () => {
    const created = await createLogin(app, { email: email(), name: "Edge", role: "member" });
    const t = created.setupToken;
    const flip = (s: string) => (s.endsWith("A") ? `${s.slice(0, -1)}B` : `${s.slice(0, -1)}A`);
    const swapCase = [...t].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
    const variants = [flip(t), t.slice(0, -1), `${t}A`, swapCase, ` ${t}`, `${t} `, `${t}\n`, `#${t}`, `${t}%00`, t.replaceAll("-", "+").replaceAll("_", "/"), "", "0".repeat(43)].filter((v) => v !== t);
    const b = browser();
    const unknown = await b.post("/api/auth/setup/check", { token: "x".repeat(43) });
    for (const token of variants) {
      const res = await b.post("/api/auth/setup/check", { token });
      expect(res.status, JSON.stringify(token)).toBe(410);
      expect(res.body, JSON.stringify(token)).toEqual(unknown.body);
      const pw = await b.post("/api/auth/setup/password", { token, password: PASSWORD });
      expect(pw.status, `password with ${JSON.stringify(token)}`).toBe(410);
    }
    // The real link is untouched by all of that.
    expect((await b.post("/api/auth/setup/check", { token: t })).status).toBe(200);
  });

  it("a token of the wrong JSON type or size is a 400, never a 500", async () => {
    const b = browser();
    for (const token of [null, 123, ["a"], { a: 1 }, "x".repeat(201)]) {
      expect((await b.post("/api/auth/setup/check", { token })).status, JSON.stringify(token)).toBe(400);
      expect((await b.post("/api/auth/setup/password", { token, password: PASSWORD })).status, JSON.stringify(token)).toBe(400);
    }
    expect((await b.post("/api/auth/setup/check", {})).status).toBe(400);
  });

  it("two people racing with the same link: exactly one wins, one credential row exists, the loser gets no cookie", async () => {
    const created = await createLogin(app, { email: email(), name: "Racer", role: "member" });
    const [a, b] = [browser(), browser()];
    const [ra, rb] = await Promise.all([
      a.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD }),
      b.post("/api/auth/setup/password", { token: created.setupToken, password: `${PASSWORD} two` }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 410]);
    const loser = ra.status === 410 ? a : b;
    expect(loser.cookies.size).toBe(0);
    const accounts = await migrator.selectFrom("auth_accounts").select("id").where("user_id", "=", created.userId).where("provider_id", "=", "credential").execute();
    expect(accounts).toHaveLength(1);
    expect(await migrator.selectFrom("auth_setup_tokens").select("id").where("user_id", "=", created.userId).execute()).toEqual([]);
  });

  it("a rejected password does not use the link up: the person can try again", async () => {
    const created = await createLogin(app, { email: email(), name: "Retry", role: "member" });
    const b = browser();
    const short = await b.post("/api/auth/setup/password", { token: created.setupToken, password: "short" });
    expect(short.status).toBe(400);
    expect(errCode(short)).toBe("password_too_short");
    expect(b.cookies.size).toBe(0);
    expect((await b.post("/api/auth/setup/password", { token: created.setupToken, password: "password1234" })).status).toBe(400);
    expect((await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD })).status).toBe(200);
  });

  it("a link for a login that was deactivated is dead (check and use), and creates no session or password", async () => {
    const created = await createLogin(app, { email: email(), name: "Gone", role: "member" });
    expect(await deactivateLogin(app, await emailOf(created.userId))).toBe(true);
    const b = browser();
    expect((await b.post("/api/auth/setup/check", { token: created.setupToken })).status).toBe(410);
    expect((await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD })).status).toBe(410);
    expect(b.cookies.size).toBe(0);
    expect(await migrator.selectFrom("auth_sessions").select("id").where("user_id", "=", created.userId).execute()).toEqual([]);
  });

  it("re-issuing a link for the same email kills the old link at once, even before the new one is used", async () => {
    const address = email();
    const first = await createLogin(app, { email: address, name: "Twice", role: "member" });
    const second = await createLogin(app, { email: address, name: "Twice", role: "member" });
    expect(second.reissued).toBe(true);
    const b = browser();
    expect((await b.post("/api/auth/setup/check", { token: first.setupToken })).status).toBe(410);
    expect((await b.post("/api/auth/setup/check", { token: second.setupToken })).status).toBe(200);
    expect(await migrator.selectFrom("auth_setup_tokens").select("id").where("user_id", "=", first.userId).execute()).toHaveLength(1);
  });

  it("a re-issued link does not end the person's sessions until it is used (spec question: lost phone)", async () => {
    // README: "Using it ... signs the person out everywhere." A thief holding a stolen phone's
    // session keeps it until the person uses the new link, or for up to 7 days if they never do.
    const person = await enrolledUser();
    await createLogin(app, { email: person.email, name: "Test Person", role: "member" });
    expect((await auth.session(person.browser.headers())).status).toBe("signed-in");
  });
});

async function emailOf(userId: string): Promise<string> {
  return (await migrator.selectFrom("auth_users").select("email").where("id", "=", userId).executeTakeFirstOrThrow()).email;
}

// ---------------------------------------------------------------------------------------------
describe("passwords: how the 12-character rule counts", () => {
  const setPassword = async (password: string) => {
    const created = await createLogin(app, { email: email(), name: "Pw", role: "member" });
    const b = browser();
    const res = await b.post("/api/auth/setup/password", { token: created.setupToken, password });
    return { res, b, created };
  };

  it("11 characters are refused and 12 are accepted", async () => {
    expect(errCode((await setPassword("a1b2c3d4e5f")).res)).toBe("password_too_short");
    expect((await setPassword("a1b2c3d4e5f6")).res.status).toBe(200);
  });

  it("counts characters, not bytes: 6 two-byte characters (12 bytes) are too short", async () => {
    expect(errCode((await setPassword("éééééé")).res)).toBe("password_too_short");
    expect(errCode((await setPassword("日本語日本語日本語")).res)).toBe("password_too_short"); // 9 chars, 27 bytes
    expect((await setPassword("日本語日本語日本語日本語")).res.status).toBe(200); // 12 chars
  });

  it("counts code points, not UTF-16 units: 11 emoji (22 units) are too short, 12 are enough", async () => {
    expect(errCode((await setPassword("😀".repeat(11))).res)).toBe("password_too_short");
    expect((await setPassword("🔑".repeat(12))).res.status).toBe(200);
  });

  it("counts code points, not grapheme clusters: two family emoji (2 clusters, 14 code points) pass (spec question)", async () => {
    // The UI spec says "At least 12 characters". People count clusters; the code counts code points.
    const family = "👨‍👩‍👧‍👦";
    expect([...family].length).toBe(7);
    expect((await setPassword(family + family)).res.status).toBe(200);
  });

  it("128 characters are accepted and 129 are refused with the 'at most 128' code", async () => {
    expect((await setPassword("k".repeat(127) + "1")).res.status).toBe(200);
    const long = await setPassword("k".repeat(129));
    expect(long.res.status).toBe(400);
    expect(errCode(long.res)).toBe("password_too_long");
    expect(errCode((await setPassword("🔑".repeat(129))).res)).toBe("password_too_long");
  });

  it("BUG: a password of 65 emoji (65 characters, 130 UTF-16 units) is accepted by the length rule, so setup must finish and the person must be able to sign in", async () => {
    // setup/password counts code points (65 <= 128) but Better Auth counts UTF-16 units (130 > 128), so
    // the link is used up, the password is stored, and then enrolment answers 500 and every later sign-in is a 401.
    const password = "🔑".repeat(65);
    const { res, created } = await setPassword(password);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const login = await browser().post("/api/auth/sign-in", { email: await emailOf(created.userId), password });
    expect(login.status).toBe(200);
  });

  it("an 8 KB password is a clean 400, over the body limit a clean 413; neither hashes anything", async () => {
    const created = await createLogin(app, { email: email(), name: "Pw", role: "member" });
    const b = browser();
    const big = await b.post("/api/auth/setup/password", { token: created.setupToken, password: "p".repeat(7000) });
    expect(big.status).toBe(400);
    expect(errCode(big)).toBe("password_too_long");
    const huge = await b.post("/api/auth/setup/password", { token: created.setupToken, password: "p".repeat(9000) });
    expect(huge.status).toBe(413);
    expect((await b.post("/api/auth/setup/check", { token: created.setupToken })).status).toBe(200);
  });

  it("common passwords are refused whatever the case or surrounding spaces; a password only near a common one is not", async () => {
    for (const p of ["password1234", "PASSWORD1234", "Password1234", " password1234", "password1234 ", "  password1234  "]) {
      expect(errCode((await setPassword(p)).res), JSON.stringify(p)).toBe("password_too_common");
    }
    expect((await setPassword("password1234-" + randomUUID())).res.status).toBe(200);
  });

  it("odd Unicode is never a 500: NUL, a lone surrogate, combining marks, right-to-left, and it signs in again with the same string", async () => {
    for (const p of ["a\u0000bcdefghijkl", "\ud800".repeat(12), "é".repeat(12), "‮abcdefghijkl", "tab\tand\nnewline!!"]) {
      secrets.push(p);
      const { res, created } = await setPassword(p);
      expect(res.status, JSON.stringify(p)).toBe(200);
      const again = browser();
      const login = await again.post("/api/auth/sign-in", { email: await emailOf(created.userId), password: p });
      expect(login.status, `sign in with ${JSON.stringify(p)}`).toBe(200);
    }
  });

  it("a password set decomposed (NFD) can be typed composed (NFC) and the other way round", async () => {
    const nfd = "Café Cremé Brulée!!".normalize("NFD");
    const nfc = nfd.normalize("NFC");
    expect(nfd).not.toBe(nfc);
    const a = await setPassword(nfd);
    expect((await browser().post("/api/auth/sign-in", { email: await emailOf(a.created.userId), password: nfc })).status).toBe(200);
    const b = await setPassword(nfc);
    expect((await browser().post("/api/auth/sign-in", { email: await emailOf(b.created.userId), password: nfd })).status).toBe(200);
  });

  it("the password hash is salted: the same password gives two different hashes, and no plain text is stored anywhere in the account row", async () => {
    const one = await setPassword("same password twice");
    const two = await setPassword("same password twice");
    const hashes = await Promise.all([one, two].map((x) => migrator.selectFrom("auth_accounts").select("password").where("user_id", "=", x.created.userId).executeTakeFirstOrThrow()));
    expect(hashes[0]!.password).not.toBe(hashes[1]!.password);
    expect(hashes[0]!.password).not.toContain("same password");
  });
});

// ---------------------------------------------------------------------------------------------
describe("enumeration: unknown email, wrong password, deactivated and password-only look alike", () => {
  /** What a client can see of a response, minus what differs by design (date, request id). */
  const shape = (r: { status: number; body: Record<string, unknown>; response: Response }) => ({
    status: r.status,
    body: r.body,
    headers: [...r.response.headers].filter(([k]) => !["date", "x-request-id", "content-length"].includes(k)).sort(),
    setCookies: r.response.headers.getSetCookie(),
  });

  it("the four wrong-password cases answer with the same status, body, headers and cookies", async () => {
    const enrolled = await enrolledUser();
    const half = await passwordOnlyUser();
    const gone = await enrolledUser();
    await deactivateLogin(app, gone.email);
    const attempts = [
      { email: `nobody-${randomUUID().slice(0, 6)}@example.org`, password: "not the password at all" },
      { email: enrolled.email, password: "not the password at all" },
      { email: half.email, password: "not the password at all" },
      { email: gone.email, password: "not the password at all" },
      { email: gone.email, password: PASSWORD }, // the deactivated person's real old password
    ];
    const shapes = [];
    for (const a of attempts) shapes.push(shape(await browser().post("/api/auth/sign-in", a)));
    for (const s of shapes) expect(s).toEqual(shapes[0]);
    expect(shapes[0]!.status).toBe(401);
    expect(shapes[0]!.setCookies).toEqual([]);
  });

  it("each of them does the same bookkeeping: one failure row and one audit row, neither holding the email", async () => {
    const enrolled = await enrolledUser();
    const cases = [`ghost-${randomUUID().slice(0, 6)}@example.org`, enrolled.email];
    const deltas = [];
    for (const address of cases) {
      const before = [await count("auth_sign_in_failures"), await count("audit_log")];
      await browser().post("/api/auth/sign-in", { email: address, password: "wrong wrong wrong" });
      deltas.push([(await count("auth_sign_in_failures")) - before[0]!, (await count("audit_log")) - before[1]!]);
    }
    expect(deltas).toEqual([
      [1, 1],
      [1, 1],
    ]);
    const keys = (await migrator.selectFrom("auth_sign_in_failures").select("account_key").execute()).map((r) => r.account_key);
    expect(keys.sort()).toEqual([accountKey(KEY, cases[0]!), accountKey(KEY, cases[1]!)].sort());
    for (const k of keys) expect(k).not.toContain("example");
  });

  it("a malformed email gives a 400 for known and unknown alike, and costs no budget", async () => {
    const enrolled = await enrolledUser();
    for (const address of ["", "x".repeat(321), enrolled.email.padEnd(400, "x")]) {
      expect((await browser().post("/api/auth/sign-in", { email: address, password: PASSWORD })).status, address.slice(0, 20)).toBe(400);
    }
    expect(await count("auth_sign_in_failures")).toBe(0);
  });

  it("an email that is not an address at all is the same 401 as a wrong password (not a 400 that tells it apart)", async () => {
    const wrong = shape(await browser().post("/api/auth/sign-in", { email: "no-at-sign", password: PASSWORD }));
    const unknown = shape(await browser().post("/api/auth/sign-in", { email: "nobody@example.org", password: PASSWORD }));
    expect(wrong).toEqual(unknown);
  });
});

// ---------------------------------------------------------------------------------------------
describe("rate limits", () => {
  const failures = async (n: number, address: string, headers: Record<string, string> = {}, service: AuthService = auth) => {
    for (let i = 0; i < n; i++) await browser(service, headers).post("/api/auth/sign-in", { email: address, password: `wrong password ${i}` });
  };
  const seed = (rows: Array<{ account: string; ip: string; agoSeconds: number }>) =>
    Promise.all(rows.map((r) => sql`insert into auth_sign_in_failures (account_key, ip_key, at) values (${r.account}, ${r.ip}, now() - make_interval(secs => ${r.agoSeconds}))`.execute(migrator)));

  it("the account budget is shared by every way of typing the same email", async () => {
    const person = await enrolledUser();
    const variants = [person.email, person.email.toUpperCase(), ` ${person.email} `, person.email.replace(/^./, (c) => c.toUpperCase()), `\t${person.email}\n`];
    for (const v of variants) expect((await browser().post("/api/auth/sign-in", { email: v, password: "wrong password" })).status).toBe(401);
    const sixth = await browser().post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
    expect(sixth.status).toBe(429);
    expect(sixth.response.headers.get("retry-after")).toBe(String((sixth.body.error as { retryAfterSeconds: number }).retryAfterSeconds));
  });

  it("while limited, further tries do not extend the pause and add no rows (hammering gains nothing)", async () => {
    const address = email();
    await failures(5, address);
    const first = (await browser().post("/api/auth/sign-in", { email: address, password: "x".repeat(14) })).body.error as { retryAfterSeconds: number };
    for (let i = 0; i < 10; i++) expect((await browser().post("/api/auth/sign-in", { email: address, password: "again again again" })).status).toBe(429);
    const later = (await browser().post("/api/auth/sign-in", { email: address, password: "x".repeat(14) })).body.error as { retryAfterSeconds: number };
    expect(later.retryAfterSeconds).toBeLessThanOrEqual(first.retryAfterSeconds);
    expect(await count("auth_sign_in_failures")).toBe(5);
  });

  it("the 429 says '1 minute' (singular) under a minute, then rounds up to whole minutes", async () => {
    const cases: Array<[number, string]> = [
      [14 * 60 + 30, "Too many tries. Try again in 1 minute."],
      [14 * 60 + 5, "Too many tries. Try again in 1 minute."],
      [13 * 60 + 30, "Too many tries. Try again in 2 minutes."],
      [10 * 60, "Too many tries. Try again in 5 minutes."],
      [5, "Too many tries. Try again in 15 minutes."],
    ];
    for (const [ago, text] of cases) {
      const address = email();
      await migrator.deleteFrom("auth_sign_in_failures").execute();
      await seed(Array.from({ length: 5 }, () => ({ account: accountKey(KEY, address), ip: "unknown", agoSeconds: ago })));
      const res = await browser().post("/api/auth/sign-in", { email: address, password: PASSWORD });
      expect(res.status, text).toBe(429);
      expect((res.body.error as { message: string }).message).toBe(text);
    }
  });

  it("the budget comes back one failure at a time as old failures leave the 15-minute window", async () => {
    const address = email();
    const key = accountKey(KEY, address);
    // 3 old failures (16 min ago) and 2 recent: only the recent two count.
    await seed([
      ...Array.from({ length: 3 }, () => ({ account: key, ip: "unknown", agoSeconds: 16 * 60 })),
      ...Array.from({ length: 2 }, () => ({ account: key, ip: "unknown", agoSeconds: 30 })),
    ]);
    for (let i = 0; i < 3; i++) expect((await browser().post("/api/auth/sign-in", { email: address, password: "wrong password" })).status, `try ${i + 3}`).toBe(401);
    expect((await browser().post("/api/auth/sign-in", { email: address, password: "wrong password" })).status).toBe(429);
    // The old rows are gone, the five that count are kept.
    expect(await migrator.selectFrom("auth_sign_in_failures").select("id").execute()).toHaveLength(5);
  });

  it("a successful sign-in does not hide earlier failures, and failures of other emails never touch this one", async () => {
    const a = await enrolledUser();
    const b = await enrolledUser();
    await failures(4, a.email);
    await signInFully(a);
    expect((await browser().post("/api/auth/sign-in", { email: a.email, password: "wrong password" })).status).toBe(401);
    expect((await browser().post("/api/auth/sign-in", { email: a.email, password: PASSWORD })).status).toBe(429);
    expect((await browser().post("/api/auth/sign-in", { email: b.email, password: PASSWORD })).status).toBe(200);
  });

  it("one person's 5 wrong passwords lock that email out for 15 minutes even with the right password, from anywhere (spec question: lock lever)", async () => {
    // Anyone who knows an email can pause that person's sign-in. The design accepts the limit; the PM may
    // want an answer for it (e.g. keying by email + IP prefix once M1.4 gives a real client IP).
    const victim = await enrolledUser();
    await failures(5, victim.email, { "cf-connecting-ip": "198.51.100.9" }, authIp);
    const own = await browser(authIp, { "cf-connecting-ip": "203.0.113.50" }).post("/api/auth/sign-in", { email: victim.email, password: PASSWORD });
    expect(own.status).toBe(429);
  });

  it("without a trusted IP header, 20 failures for any emails pause sign-in for everyone (accepted until M1.4)", async () => {
    const person = await enrolledUser();
    for (let i = 0; i < 20; i++) await browser().post("/api/auth/sign-in", { email: `x${i}-${randomUUID().slice(0, 5)}@example.org`, password: "wrong password" });
    const res = await browser().post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
    expect(res.status).toBe(429);
    expect((res.body.error as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(14 * 60);
  });

  it("spoofed X-Forwarded-For, Forwarded, X-Real-IP and CF headers change nothing when no header is trusted: one shared bucket, no ip_prefix", async () => {
    const mark = await auditMark();
    for (let i = 0; i < 20; i++) {
      const headers = { "x-forwarded-for": `198.51.${i}.7`, forwarded: `for=203.0.${i}.9`, "x-real-ip": `192.0.${i}.1`, "cf-connecting-ip": `100.64.${i}.2` };
      await browser(auth, headers).post("/api/auth/sign-in", { email: `spoof${i}-${randomUUID().slice(0, 5)}@example.org`, password: "wrong password" });
    }
    const person = await enrolledUser();
    const next = await browser(auth, { "x-forwarded-for": "8.8.8.8", "x-real-ip": "9.9.9.9" }).post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
    expect(next.status).toBe(429);
    expect((await migrator.selectFrom("auth_sign_in_failures").select("ip_key").distinct().execute()).map((r) => r.ip_key)).toEqual(["unknown"]);
    const rows = await auditFor("sign_in_failed", mark);
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const row of rows) expect(row.ip_prefix).toBeNull();
  });

  it("with AUTH_TRUSTED_IP_HEADER set, X-Forwarded-For, Forwarded and X-Real-IP are still ignored", async () => {
    const mark = await auditMark();
    const spoof = { "x-forwarded-for": "198.51.100.1", forwarded: "for=198.51.100.1", "x-real-ip": "198.51.100.1" };
    for (let i = 0; i < 25; i++) await browser(authIp, { ...spoof, "x-forwarded-for": `198.51.${i}.1` }).post("/api/auth/sign-in", { email: `t${i}-${randomUUID().slice(0, 5)}@example.org`, password: "wrong password" });
    expect((await migrator.selectFrom("auth_sign_in_failures").select("ip_key").distinct().execute()).map((r) => r.ip_key)).toEqual(["unknown"]);
    const rows = await auditFor("sign_in_failed", mark);
    expect(rows).toHaveLength(20); // the 21st and later tries are limited (429) and not audited
    for (const row of rows) expect(row.ip_prefix).toBeNull();
  });

  it("with the header trusted, the /24 is the unit for IPv4: same /24 shares 20, another /24 has its own", async () => {
    const person = await enrolledUser();
    for (let i = 0; i < 20; i++) await browser(authIp, { "cf-connecting-ip": `203.0.113.${i + 1}` }).post("/api/auth/sign-in", { email: `p${i}-${randomUUID().slice(0, 5)}@example.org`, password: "wrong password" });
    expect((await browser(authIp, { "cf-connecting-ip": "203.0.113.250" }).post("/api/auth/sign-in", { email: person.email, password: PASSWORD })).status).toBe(429);
    expect((await browser(authIp, { "cf-connecting-ip": "203.0.114.1" }).post("/api/auth/sign-in", { email: person.email, password: PASSWORD })).status).toBe(200);
  });

  it("the /48 is the unit for IPv6, and an IPv4-mapped address lands in its IPv4 bucket", async () => {
    const person = await enrolledUser();
    for (let i = 0; i < 20; i++) await browser(authIp, { "cf-connecting-ip": `2001:db8:1:${i.toString(16)}::1` }).post("/api/auth/sign-in", { email: `v6${i}-${randomUUID().slice(0, 5)}@example.org`, password: "wrong password" });
    expect((await browser(authIp, { "cf-connecting-ip": "2001:db8:1:ffff::9" }).post("/api/auth/sign-in", { email: person.email, password: PASSWORD })).status).toBe(429);
    expect((await browser(authIp, { "cf-connecting-ip": "2001:db8:2::1" }).post("/api/auth/sign-in", { email: person.email, password: PASSWORD })).status).toBe(200);

    const other = await enrolledUser();
    for (let i = 0; i < 20; i++) await browser(authIp, { "cf-connecting-ip": "::ffff:192.0.2.77" }).post("/api/auth/sign-in", { email: `m${i}-${randomUUID().slice(0, 5)}@example.org`, password: "wrong password" });
    expect((await browser(authIp, { "cf-connecting-ip": "192.0.2.5" }).post("/api/auth/sign-in", { email: other.email, password: PASSWORD })).status).toBe(429);
  });

  it("malformed values of the trusted header count as 'unknown' and record no prefix: lists, ports, brackets, zones, garbage, out-of-range", async () => {
    const mark = await auditMark();
    const odd = ["garbage", "198.51.100.1, 203.0.113.9", "198.51.100.1:443", "[2001:db8::1]", "999.1.1.1", "198.51.100", "2001:db8::1%eth0", "198.51.100.1 evil", "0x7f.1", "198.051.100.001", ""];
    for (const value of odd) await browser(authIp, { "cf-connecting-ip": value }).post("/api/auth/sign-in", { email: email(), password: "wrong password" });
    const rows = await auditFor("sign_in_failed", mark);
    expect(rows).toHaveLength(odd.length);
    for (const row of rows) expect(row.ip_prefix, JSON.stringify(row)).toBeNull();
    expect((await migrator.selectFrom("auth_sign_in_failures").select("ip_key").distinct().execute()).map((r) => r.ip_key)).toEqual(["unknown"]);
  });

  it("a trusted-header value is trimmed and only its prefix is kept: the full address is in no table", async () => {
    const mark = await auditMark();
    await browser(authIp, { "cf-connecting-ip": "  203.0.113.77  " }).post("/api/auth/sign-in", { email: email(), password: "wrong password" });
    expect((await auditFor("sign_in_failed", mark)).at(-1)!.ip_prefix).toBe("203.0.113.0/24");
    const dump = JSON.stringify(await migrator.selectFrom("auth_sign_in_failures").selectAll().execute());
    expect(dump).not.toContain("203.0.113.77");
  });
});

// ---------------------------------------------------------------------------------------------
describe("two-step codes", () => {
  it("one step either side is accepted, two steps either side are refused", async () => {
    const person = await enrolledUser();
    for (const offset of [-2, 2]) {
      const b = browser();
      await b.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
      const res = await b.post("/api/auth/two-factor/totp", { code: totpCode(person.secret, Date.now(), offset) });
      expect(res.status, `offset ${offset}`).toBe(401);
      expect(errCode(res)).toBe("invalid_code");
      expect((await auth.session(b.headers())).status).toBe("signed-out");
    }
    for (const offset of [-1, 1]) {
      const b = browser();
      await b.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
      expect((await b.post("/api/auth/two-factor/totp", { code: totpCode(person.secret, Date.now(), offset) })).status, `offset ${offset}`).toBe(200);
    }
  });

  it("BUG: a code that was already used is refused the second time within its 30-second step (RFC 6238 section 5.2)", async () => {
    const person = await enrolledUser();
    // Use a step that is not the one setup/confirm just consumed (+1 is in the future, so it stays valid for 1-2 steps).
    const code = totpCode(person.secret, Date.now(), 1);
    const first = browser();
    await first.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
    expect((await first.post("/api/auth/two-factor/totp", { code })).status).toBe(200);
    const replay = browser();
    await replay.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
    const second = await replay.post("/api/auth/two-factor/totp", { code });
    expect(second.status, "the same code opened a second session").toBe(401);
    expect((await auth.session(replay.headers())).status).toBe("signed-out");
  });

  it("BUG: the code that confirmed enrolment cannot be used again to sign in within its step", async () => {
    const address = email();
    const created = await createLogin(app, { email: address, name: "Replay", role: "member" });
    const b = browser();
    const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
    const secret = secretFromUri((setup.body.enrolment as Enrolment).totpUri);
    const code = totpCode(secret);
    expect((await b.post("/api/auth/setup/confirm", { code })).status).toBe(200);
    const next = browser();
    await next.post("/api/auth/sign-in", { email: address, password: PASSWORD });
    const res = await next.post("/api/auth/two-factor/totp", { code });
    expect(res.status).toBe(401);
  });

  it("odd code values are 401 or 400, never a 500 or a session: full-width digits, letters, spaces, newlines, long, empty", async () => {
    const person = await enrolledUser();
    const b = browser();
    await b.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
    const right = totpCode(person.secret, Date.now(), 1);
    const fullWidth = [...right].map((d) => String.fromCodePoint(0xff10 + Number(d))).join("");
    for (const code of [fullWidth, "abcdef", "12345", "1234567", `${right}0`, "٠١٢٣٤٥", "1".repeat(65), ""]) {
      const res = await b.post("/api/auth/two-factor/totp", { code });
      expect([400, 401], JSON.stringify(code)).toContain(res.status);
      expect(await auth.session(b.headers())).toMatchObject({ status: "signed-out" });
      if (res.status === 401 && errCode(res) === "sign_in_again") await b.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
    }
  });

  it("a TOTP code is not a backup code and a backup code is not a TOTP code", async () => {
    const person = await enrolledUser();
    const b = browser();
    await b.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
    expect((await b.post("/api/auth/two-factor/backup-code", { code: totpCode(person.secret, Date.now(), 1) })).status).toBe(401);
    expect((await b.post("/api/auth/two-factor/totp", { code: person.backupCodes[0] })).status).toBe(401);
    expect((await auth.session(b.headers())).status).toBe("signed-out");
  });

  it("backup codes are case-sensitive as issued, and a backup code works once even when two sign-ins race for it", async () => {
    const person = await enrolledUser();
    const code = person.backupCodes[2]!;
    const flipped = [...code].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
    if (flipped !== code) {
      const b = browser();
      await b.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
      expect((await b.post("/api/auth/two-factor/backup-code", { code: flipped })).status, "case-flipped code").toBe(401);
    }
    const racers = [browser(), browser(), browser()];
    for (const r of racers) await r.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
    const results = await Promise.all(racers.map((r) => r.post("/api/auth/two-factor/backup-code", { code })));
    expect(results.filter((r) => r.status === 200), JSON.stringify(results.map((r) => r.status))).toHaveLength(1);
  });

  it("the last backup code works and reports none left; after that backup codes fail but the authenticator still works", async () => {
    const person = await enrolledUser();
    let left = -1;
    for (const code of person.backupCodes) {
      const b = browser();
      await b.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
      const res = await b.post("/api/auth/two-factor/backup-code", { code });
      expect(res.status, code).toBe(200);
      left = res.body.backupCodesLeft as number;
    }
    expect(left).toBe(0);
    const b = browser();
    await b.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
    expect((await b.post("/api/auth/two-factor/backup-code", { code: person.backupCodes[0] })).status).toBe(401);
    expect((await signInFully(person).then((x) => auth.session(x.headers()))).status).toBe("signed-in");
  });

  it("5 wrong backup codes also end the sign-in; the right code is then refused until the person signs in again", async () => {
    const person = await enrolledUser();
    const b = browser();
    await b.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
    for (let i = 0; i < 4; i++) expect(errCode(await b.post("/api/auth/two-factor/backup-code", { code: `wrong-code-${i}` }))).toBe("invalid_backup_code");
    expect(errCode(await b.post("/api/auth/two-factor/backup-code", { code: "wrong-code-4" }))).toBe("sign_in_again");
    expect(errCode(await b.post("/api/auth/two-factor/backup-code", { code: person.backupCodes[0] }))).toBe("sign_in_again");
    expect((await auth.session(b.headers())).status).toBe("signed-out");
  });

  it("wrong codes across fresh sign-ins add up: after 10 the account is locked and even a right code gets the 429 until the lock ends", async () => {
    const person = await enrolledUser();
    for (let round = 0; round < 2; round++) {
      const b = browser();
      await b.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
      for (let i = 0; i < 5; i++) await b.post("/api/auth/two-factor/totp", { code: wrongCodeFor(person.secret) });
    }
    const locked = browser();
    expect((await locked.post("/api/auth/sign-in", { email: person.email, password: PASSWORD })).status).toBe(200);
    const right = await locked.post("/api/auth/two-factor/totp", { code: totpCode(person.secret, Date.now(), 1) });
    expect(right.status).toBe(429);
    expect((right.body.error as { message: string }).message).toMatch(/^Too many tries\. Try again in \d+ minutes?\.$/);
    expect(Number(right.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await auth.session(locked.headers())).status).toBe("signed-out");
    // A backup code is held back by the same lock.
    expect((await locked.post("/api/auth/two-factor/backup-code", { code: person.backupCodes[1] })).status).toBe(429);

    await migrator.updateTable("auth_two_factors").set({ locked_until: new Date(Date.now() - 1000) }).where("user_id", "=", person.userId).execute();
    const after = browser();
    await after.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
    expect((await after.post("/api/auth/two-factor/totp", { code: totpCode(person.secret, Date.now(), -1) })).status).toBe(200);
    const row = await migrator.selectFrom("auth_two_factors").select(["failed_verification_count", "locked_until"]).where("user_id", "=", person.userId).executeTakeFirstOrThrow();
    expect(Number(row.failed_verification_count)).toBe(0);
  });

  it("the sign-in challenge belongs to its browser: a copied challenge cookie works only with its own user's code, and only once ended it is gone", async () => {
    const alice = await enrolledUser();
    const bob = await enrolledUser();
    const a = browser();
    await a.post("/api/auth/sign-in", { email: alice.email, password: PASSWORD });
    // Bob's browser gets Alice's challenge cookie instead of its own (a planted cookie).
    const planted = browser();
    for (const [k, v] of a.cookies) planted.cookies.set(k, v);
    const res = await planted.post("/api/auth/two-factor/totp", { code: totpCode(bob.secret, Date.now(), 1) });
    expect(res.status).toBe(401); // Bob's code does not open Alice's challenge
    expect((await auth.session(planted.headers())).status).toBe("signed-out");
  });

  it("a challenge cookie from someone else is replaced when you sign in yourself (login CSRF with a planted challenge)", async () => {
    const attacker = await enrolledUser();
    const victim = await enrolledUser();
    const theirs = browser();
    await theirs.post("/api/auth/sign-in", { email: attacker.email, password: PASSWORD });
    const victimBrowser = browser();
    for (const [k, v] of theirs.cookies) victimBrowser.cookies.set(k, v); // planted before the victim signs in
    await victimBrowser.post("/api/auth/sign-in", { email: victim.email, password: PASSWORD });
    const sneaky = await victimBrowser.post("/api/auth/two-factor/totp", { code: totpCode(attacker.secret, Date.now(), 1) });
    expect(sneaky.status, "the attacker's code must not complete the victim's sign-in").toBe(401);
    expect((await auth.session(victimBrowser.headers())).status).toBe("signed-out");
  });
});

// ---------------------------------------------------------------------------------------------
describe("sessions: fixation, reuse, concurrency, forged cookies, expiry edges", () => {
  const sessionCookie = (b: TestBrowser) => [...b.cookies].find(([k]) => k.includes("session_token"))!;

  it("signing in issues a new session: a cookie that was in the browser before is not elevated, and a chosen token is worthless", async () => {
    const person = await enrolledUser();
    const b = browser();
    // Fixation: the attacker plants a cookie they know before the victim signs in.
    const planted = "attackerknownvalue.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%3D";
    b.cookies.set("__Secure-vault.session_token", planted);
    await b.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
    await b.post("/api/auth/two-factor/totp", { code: totpCode(person.secret, Date.now(), 1) });
    expect(sessionCookie(b)[1]).not.toBe(planted);
    const attacker = new Headers({ cookie: `__Secure-vault.session_token=${planted}` });
    expect((await auth.session(attacker)).status).toBe("signed-out");
    expect((await auth.session(b.headers())).status).toBe("signed-in");
  });

  it("signing in as someone else in the same browser gives that person a new session and leaves the first one as it was", async () => {
    const one = await enrolledUser();
    const two = await enrolledUser();
    const b = await signInFully(one);
    const firstCookie = b.cookieHeader();
    for (const [k] of [...b.cookies]) if (k.includes("session_token")) b.cookies.delete(k);
    await b.post("/api/auth/sign-in", { email: two.email, password: PASSWORD });
    await b.post("/api/auth/two-factor/totp", { code: totpCode(two.secret, Date.now(), -1) });
    const state = await auth.session(b.headers());
    expect(state.status === "signed-in" && state.user.id).toBe(two.userId);
    const old = await auth.session(new Headers({ cookie: firstCookie }));
    expect(old.status === "signed-in" && old.user.id).toBe(one.userId);
  });

  it("every sign-in is its own session: three at once, each with its own token; signing one out leaves the others", async () => {
    const person = await enrolledUser();
    const [a, b, c] = [await signInFully(person), await signInFully(person), await signInFully(person)];
    const tokens = [a, b, c].map((x) => sessionCookie(x)[1]);
    expect(new Set(tokens).size).toBe(3);
    expect((await a.post("/api/auth/sign-out")).status).toBe(200);
    expect((await auth.session(a.headers())).status).toBe("signed-out");
    expect((await auth.session(b.headers())).status).toBe("signed-in");
    expect((await auth.session(c.headers())).status).toBe("signed-in");
    expect((await migrator.selectFrom("auth_sessions").select("id").where("user_id", "=", person.userId).execute()).length).toBeGreaterThanOrEqual(2);
  });

  it("a copied session cookie is dead after sign-out, and after sign-out of all devices, however it is replayed", async () => {
    const person = await enrolledUser();
    const live = await signInFully(person);
    const copy = live.cookieHeader();
    await live.post("/api/auth/sign-out");
    expect(await auth.session(new Headers({ cookie: copy }))).toMatchObject({ status: "signed-out", reason: "ended" });
    const other = await signInFully(person);
    const copy2 = other.cookieHeader();
    const third = await signInFully(person);
    await third.post("/api/auth/sign-out-everywhere");
    expect((await auth.session(new Headers({ cookie: copy2 }))).status).toBe("signed-out");
  });

  it("a password-only session reaches nothing: not the session check, not the two-step sign-in endpoints", async () => {
    const half = await passwordOnlyUser();
    expect((await auth.session(half.browser.headers())).status).toBe("two-factor-required");
    for (const path of ["/api/auth/two-factor/totp", "/api/auth/two-factor/backup-code"]) {
      const res = await half.browser.post(path, { code: "123456" });
      expect(res.status, path).toBe(401);
      expect(errCode(res), path).toBe("sign_in_again");
    }
    expect((await auth.session(half.browser.headers())).status).toBe("two-factor-required");
  });

  it("setup/confirm needs a password-only session: nothing, or a fully signed-in one, is a 401", async () => {
    const person = await enrolledUser();
    expect((await browser().post("/api/auth/setup/confirm", { code: "123456" })).status).toBe(401);
    const res = await person.browser.post("/api/auth/setup/confirm", { code: totpCode(person.secret, Date.now(), 1) });
    expect(res.status).toBe(401);
  });

  it("forged session_data or tampered token cookies change nothing: the user, the role and 'two-factor done' come from the database", async () => {
    const half = await passwordOnlyUser();
    const forgedData = Buffer.from(JSON.stringify({ session: { session: { userId: half.userId }, user: { id: half.userId, twoFactorEnabled: true, role: "admin" } }, expiresAt: Date.now() + 1e9 })).toString("base64url");
    const jar = half.browser.cookieHeader();
    expect((await auth.session(new Headers({ cookie: `${jar}; __Secure-vault.session_data=${forgedData}` }))).status).toBe("two-factor-required");
    expect((await auth.session(new Headers({ cookie: `__Secure-vault.session_data=${forgedData}` }))).status).toBe("signed-out");

    const person = await enrolledUser();
    const [name, value] = sessionCookie(person.browser);
    const [token, sig] = decodeURIComponent(value).split(".");
    for (const tampered of [`${token}.${sig!.slice(0, -2)}AA`, `${token}x.${sig}`, `.${sig}`, `${token}.`, token!, `${sig}.${token}`, `${token}.${sig}.${sig}`]) {
      expect((await auth.session(new Headers({ cookie: `${name}=${encodeURIComponent(tampered)}` }))).status, tampered.slice(0, 30)).toBe("signed-out");
    }
    // Another user's real token with this user's signature is not accepted either.
    const other = await enrolledUser();
    const otherToken = decodeURIComponent(sessionCookie(other.browser)[1]).split(".")[0];
    expect((await auth.session(new Headers({ cookie: `${name}=${encodeURIComponent(`${otherToken}.${sig}`)}` }))).status).toBe("signed-out");
  });

  it("the role is read on every request: demoting an admin takes effect on the next call", async () => {
    const person = await enrolledUser();
    await migrator.updateTable("users").set({ role: "admin" }).where("id", "=", person.userId).execute();
    const admin = await auth.session(person.browser.headers());
    expect(admin.status === "signed-in" && admin.user.role).toBe("admin");
    await migrator.updateTable("users").set({ role: "member" }).where("id", "=", person.userId).execute();
    const member = await auth.session(person.browser.headers());
    expect(member.status === "signed-in" && member.user.role).toBe("member");
    expect(member.status === "signed-in" && member.viewer.role).toBe("member");
  });

  it("idle expiry: a session with a second left is alive, one that ended a second ago is not", async () => {
    const person = await enrolledUser();
    await migrator.updateTable("auth_sessions").set({ expires_at: sql`now() + interval '5 seconds'` }).where("user_id", "=", person.userId).execute();
    expect((await auth.session(person.browser.headers())).status).toBe("signed-in");
    await migrator.updateTable("auth_sessions").set({ expires_at: sql`now() - interval '1 second'` }).where("user_id", "=", person.userId).execute();
    expect(await auth.session(person.browser.headers())).toMatchObject({ status: "signed-out", reason: "ended" });
  });

  it("absolute expiry: 7 days minus a few seconds is alive, 7 days plus a second is over, and recent activity doesn't help", async () => {
    const person = await enrolledUser();
    await migrator.updateTable("auth_sessions").set({ created_at: sql`now() - interval '7 days' + interval '20 seconds'`, expires_at: sql`now() + interval '23 hours'`, updated_at: sql`now()` }).where("user_id", "=", person.userId).execute();
    expect((await auth.session(person.browser.headers())).status).toBe("signed-in");
    await migrator.updateTable("auth_sessions").set({ created_at: sql`now() - interval '7 days' - interval '1 second'` }).where("user_id", "=", person.userId).execute();
    expect((await auth.session(person.browser.headers())).status).toBe("signed-out");
  });

  it("the session row keeps no IP address and no more than the user agent, even with proxy headers present", async () => {
    const person = await enrolledUser();
    const b = browser(authIp, { "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "198.51.100.8", "user-agent": "tester-agent" });
    await b.post("/api/auth/sign-in", { email: person.email, password: PASSWORD });
    await b.post("/api/auth/two-factor/totp", { code: totpCode(person.secret, Date.now(), 1) });
    const rows = await migrator.selectFrom("auth_sessions").select(["ip_address", "user_agent"]).where("user_id", "=", person.userId).execute();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.ip_address ?? "").toBe("");
  });

  it("every cookie any endpoint sets (session, challenge, clearing) is HttpOnly, Secure, SameSite=Lax, Path=/ and host-only", async () => {
    const person = await enrolledUser();
    const lines: string[] = [];
    const grab = (r: { response: Response }) => lines.push(...r.response.headers.getSetCookie());
    const b = browser();
    grab(await b.post("/api/auth/sign-in", { email: person.email, password: PASSWORD }));
    grab(await b.post("/api/auth/two-factor/totp", { code: wrongCodeFor(person.secret) }));
    grab(await b.post("/api/auth/two-factor/totp", { code: totpCode(person.secret, Date.now(), 1) }));
    grab(await b.post("/api/auth/sign-out"));
    const half = await passwordOnlyUser();
    grab(await half.browser.post("/api/auth/sign-in", { email: half.email, password: PASSWORD }));
    grab(await half.browser.post("/api/auth/sign-out-everywhere"));
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      expect(line, line).toMatch(/;\s*HttpOnly/i);
      expect(line, line).toMatch(/;\s*Secure/i);
      expect(line, line).toMatch(/;\s*SameSite=Lax/i);
      expect(line, line).toMatch(/;\s*Path=\//i);
      expect(line, line).not.toMatch(/;\s*Domain=/i);
    }
    const session = lines.find((l) => l.includes("session_token=") && !/Max-Age=0/i.test(l))!;
    expect(Number(/Max-Age=(\d+)/i.exec(session)![1])).toBeLessThanOrEqual(24 * 3600);
    const challenge = lines.find((l) => l.includes("two_factor=") && !/Max-Age=0/i.test(l))!;
    expect(Number(/Max-Age=(\d+)/i.exec(challenge)![1])).toBeLessThanOrEqual(600);
  });
});

// ---------------------------------------------------------------------------------------------
describe("CSRF and origin on every POST under /api/auth", () => {
  const ROUTES = ["/api/auth/sign-in", "/api/auth/two-factor/totp", "/api/auth/two-factor/backup-code", "/api/auth/setup/check", "/api/auth/setup/password", "/api/auth/setup/confirm", "/api/auth/sign-out", "/api/auth/sign-out-everywhere"];
  const BAD_ORIGINS = [
    undefined, // missing
    "null", // sandboxed iframe or redirected cross-site request
    "",
    "https://evil.example",
    `${ORIGIN}/`, // trailing slash
    "HTTP://127.0.0.1:3000",
    "http://127.0.0.1:3000.evil.example",
    "http://127.0.0.1:30001",
    "http://127.0.0.1",
    "https://127.0.0.1:3000",
    "http://localhost:3000",
    "http://user@127.0.0.1:3000",
    `${ORIGIN}, https://evil.example`,
    `https://evil.example, ${ORIGIN}`,
    ` ${ORIGIN}`.trimEnd() + "\u0000",
  ];
  const post = (path: string, origin: string | undefined, extra: Record<string, string> = {}, body: unknown = {}) => {
    const headers = new Headers({ "content-type": "application/json", ...extra });
    if (origin !== undefined) headers.set("origin", origin);
    return auth.handle(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
  };

  it("every route refuses every wrong Origin with 403 forbidden, no cookie, and no CORS permission", async () => {
    for (const path of ROUTES) {
      for (const origin of BAD_ORIGINS) {
        let res: Response;
        try {
          res = await post(path, origin);
        } catch {
          continue; // the platform's own Headers refuses this value before it can be sent
        }
        expect(res.status, `${path} Origin=${JSON.stringify(origin)}`).toBe(403);
        expect(res.headers.getSetCookie()).toEqual([]);
        expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
        expect(await res.json()).toEqual({ error: { code: "forbidden", message: expect.any(String) } });
      }
    }
  });

  it("a Referer without an Origin is not enough; neither is a same-origin Sec-Fetch-Site or a correct Host", async () => {
    for (const path of ROUTES) {
      const res = await post(path, undefined, { referer: `${ORIGIN}/sign-in`, "sec-fetch-site": "same-origin", host: "127.0.0.1:3000" });
      expect(res.status, path).toBe(403);
    }
  });

  it("a cross-site request cannot sign anyone out or in: sessions survive, no failure is counted, no audit row is written", async () => {
    const person = await enrolledUser();
    const before = [await count("audit_log"), await count("auth_sign_in_failures")];
    const headers = { cookie: person.browser.cookieHeader() };
    for (const path of ["/api/auth/sign-out", "/api/auth/sign-out-everywhere"]) expect((await post(path, "https://evil.example", headers)).status).toBe(403);
    expect((await post("/api/auth/sign-in", "https://evil.example", {}, { email: person.email, password: "wrong password" })).status).toBe(403);
    expect((await auth.session(person.browser.headers())).status).toBe("signed-in");
    expect([await count("audit_log"), await count("auth_sign_in_failures")]).toEqual(before);
  });

  it("a cross-site HTML form (form-encoded, text/plain, multipart) is refused whether or not the Origin is right", async () => {
    for (const type of ["application/x-www-form-urlencoded", "text/plain", "multipart/form-data; boundary=x", "text/plain;charset=UTF-8"]) {
      for (const origin of ["https://evil.example", ORIGIN]) {
        const res = await auth.handle(new Request(`${ORIGIN}/api/auth/sign-out`, { method: "POST", headers: { origin, "content-type": type }, body: "{}" }));
        expect(res.status, `${type} from ${origin}`).toBe(origin === ORIGIN ? 415 : 403);
      }
    }
  });

  it("no GET, HEAD, OPTIONS, PUT, PATCH or DELETE changes state or answers CORS preflight, on any route", async () => {
    const person = await enrolledUser();
    for (const path of ROUTES) {
      for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"]) {
        const res = await auth.handle(new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, cookie: person.browser.cookieHeader() } }));
        expect(res.status, `${method} ${path}`).toBe(405);
        expect(res.headers.get("allow")).toBe("POST");
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
      }
    }
    expect((await auth.session(person.browser.headers())).status).toBe("signed-in");
  });

  it("paths that only look like auth routes are 404: case, trailing slash, dot segments, encoded slashes, double slashes, extra segments", async () => {
    for (const path of ["/api/auth/SIGN-IN", "/api/auth/sign-in/", "/api/auth//sign-in", "/api/auth/sign-in/x", "/api/auth/sign-in.json", "/api/auth/%73ign-in", "/api/auth/sign%2Din", "/api/auth/", "/api/auth", "/api/auth/get-session", "/api/auth/list-sessions", "/api/auth/revoke-session", "/api/auth/change-password", "/api/auth/two-factor/enable", "/api/auth/two-factor/disable", "/api/auth/two-factor/generate-backup-codes", "/api/auth/forget-password", "/api/auth/sign-up/email", "/api/auth/update-user", "/api/auth/delete-user"]) {
      const res = await post(path, ORIGIN);
      expect(res.status, path).toBe(404);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("failure paths of the service itself", () => {
  it("with the database unreachable, sign-in is a JSON 500 that holds no email, no password and no connection detail, and the session check throws (the gate then answers 503)", async () => {
    const dead = createDb(["postgres", "://nobody:hunter2pass@127.0.0.1:1/nothing"].join("")) // joined: not a real credential;
    const lines: string[] = [];
    const service = createAuthService(dead, { appUrl: ORIGIN, encryptionKey: KEY, trustedIpHeader: null }, { log: (l, m, f) => void lines.push(JSON.stringify({ l, m, ...f })) });
    const b = new TestBrowser((r) => service.handle(r), ORIGIN);
    const address = "dead-db@example.org";
    const res = await b.post("/api/auth/sign-in", { email: address, password: "secret password here" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "internal_error", message: expect.any(String) } });
    expect(res.response.headers.getSetCookie()).toEqual([]);
    await expect(service.session(new Headers({ cookie: "__Secure-vault.session_token=a.b" }))).rejects.toBeDefined();
    const text = lines.join("\n");
    for (const needle of [address, "secret password here", "hunter2pass", "127.0.0.1", "nobody"]) expect(text).not.toContain(needle);
    await dead.destroy().catch(() => {});
  });

  it("an unknown route, bad JSON and a huge declared length are answered before any database work", async () => {
    const before = [await count("audit_log"), await count("auth_sign_in_failures")];
    const headers = { origin: ORIGIN, "content-type": "application/json" };
    expect((await auth.handle(new Request(`${ORIGIN}/api/auth/sign-in`, { method: "POST", headers: { ...headers, "content-length": "99999" }, body: "{}" }))).status).toBe(413);
    expect((await auth.handle(new Request(`${ORIGIN}/api/auth/sign-in`, { method: "POST", headers, body: "[1,2,3]" }))).status).toBe(400);
    expect((await auth.handle(new Request(`${ORIGIN}/api/auth/sign-in`, { method: "POST", headers, body: "null" }))).status).toBe(400);
    expect((await auth.handle(new Request(`${ORIGIN}/api/auth/sign-in`, { method: "POST", headers, body: "" }))).status).toBe(400);
    expect([await count("audit_log"), await count("auth_sign_in_failures")]).toEqual(before);
  });

  it("nothing logged during this whole file holds an email, a password, a code, a token, a cookie or a Postgres detail (item e)", () => {
    const text = logged.join("\n");
    expect(text).not.toMatch(/@example\.org/);
    for (const s of new Set(secrets)) if (s.length >= 6) expect(text.includes(s), `a secret of length ${s.length} was logged`).toBe(false);
    expect(text).not.toMatch(/"(token|password|email|secret|code|cookie)":/);
    expect(text).not.toMatch(/Key \(|violates|duplicate key|DETAIL|session_token/i);
  });
});
