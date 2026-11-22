import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogin, deactivateLogin } from "../src/auth/logins.ts";
import { createAuthService, type AuthService } from "../src/auth/service.ts";
import { createDb } from "../src/client.ts";
import { migrateUp } from "../src/migrate.ts";
import type { Database } from "../src/schema.ts";
import { TestBrowser } from "./support/auth-client.ts";
import { freshDatabase, type FreshDatabase } from "./support/fresh-database.ts";
import { rawQuery } from "./support/raw-sql.ts";
import { secretFromUri, totpCode } from "./support/totp.ts";

// Independent tester round for M1.3: the Privacy section of docs/design/m1-3-sign-in.md
// (deactivation removes everything listed, audit rows kept, ip_prefix only on four events, no personal
// data in any table or log beyond what the design allows).
const KEY = "tester-privacy-key-".padEnd(48, "p");
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery";
const NAME = "Zephyrine Quuxington-Smythe";

let fresh: FreshDatabase;
let migrator: Kysely<Database>;
let app: Kysely<Database>;
let auth: AuthService;
let authIp: AuthService;
let logged: string[];

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

const browser = (service: AuthService = auth, headers: Record<string, string> = {}) => new TestBrowser((r) => service.handle(r), ORIGIN, headers);

async function enrolled(address = `priv-${randomUUID().slice(0, 8)}@example.org`, service: AuthService = auth) {
  const created = await createLogin(app, { email: address, name: NAME, role: "member" });
  const b = browser(service);
  const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
  const enrolment = setup.body.enrolment as { totpUri: string; backupCodes: string[] };
  const secret = secretFromUri(enrolment.totpUri);
  expect((await b.post("/api/auth/setup/confirm", { code: totpCode(secret) })).status).toBe(200);
  return { address, created, secret, backupCodes: enrolment.backupCodes, b };
}

/** Every row of every table in the public schema as text, for "this string is stored nowhere" checks. */
async function everyRowAsText(skip: string[] = []): Promise<string> {
  const tables = await rawQuery<{ tablename: string }>(fresh.adminUrl, "select tablename from pg_tables where schemaname = 'public'");
  const parts: string[] = [];
  for (const { tablename } of tables) {
    if (skip.includes(tablename)) continue;
    const rows = await rawQuery<{ t: string }>(fresh.adminUrl, `select t::text as t from "${tablename}" t`);
    parts.push(...rows.map((r) => `${tablename}: ${r.t}`));
  }
  return parts.join("\n");
}

describe("deactivation with every auth table populated", () => {
  it("removes the password hash, secret, backup codes, sessions, links and challenges of the user, in every table, and keeps the audit rows", async () => {
    const { address, created, secret, b } = await enrolled();
    // Populate every table: a second session, a fresh setup link, a sign-in challenge in flight, failed attempts.
    const second = browser();
    await second.post("/api/auth/sign-in", { email: address, password: PASSWORD });
    await second.post("/api/auth/two-factor/totp", { code: totpCode(secret, Date.now(), 1) });
    await createLogin(app, { email: address, name: NAME, role: "member" });
    const midFlight = browser();
    await midFlight.post("/api/auth/sign-in", { email: address, password: PASSWORD });
    await midFlight.post("/api/auth/two-factor/totp", { code: "000000" }); // leaves a 2fa-attempts row
    await browser().post("/api/auth/sign-in", { email: address, password: "wrong wrong wrong" });
    const auditBefore = Number((await migrator.selectFrom("audit_log").select(sql<string>`count(*)`.as("n")).where("actor_user_id", "=", created.userId).executeTakeFirstOrThrow()).n);
    expect(auditBefore).toBeGreaterThan(3);

    expect(await deactivateLogin(app, address)).toBe(true);

    for (const [table, column] of [["auth_users", "id"], ["auth_accounts", "user_id"], ["auth_two_factors", "user_id"], ["auth_sessions", "user_id"], ["auth_setup_tokens", "user_id"]] as const) {
      const { rows } = await sql`select 1 from ${sql.table(table)} where ${sql.ref(column)} = ${created.userId}`.execute(migrator);
      expect(rows, table).toEqual([]);
    }
    const user = await migrator.selectFrom("users").selectAll().where("id", "=", created.userId).executeTakeFirstOrThrow();
    expect(user).toMatchObject({ role: "member", person_id: null });
    expect(user.deactivated_at).toBeInstanceOf(Date);
    const auditAfter = Number((await migrator.selectFrom("audit_log").select(sql<string>`count(*)`.as("n")).where("actor_user_id", "=", created.userId).executeTakeFirstOrThrow()).n);
    expect(auditAfter, "audit rows are kept").toBe(auditBefore);
    expect(await migrator.selectFrom("people").select("display_name").where("id", "=", created.personId).executeTakeFirstOrThrow()).toEqual({ display_name: NAME });
    expect((await auth.session(b.headers())).status).toBe("signed-out");
    expect((await auth.session(second.headers())).status).toBe("signed-out");
  });

  it("a sign-in challenge open at deactivation is deleted with the rest of the user's sign-in data", async () => {
    // auth_verifications.value holds the user id of an open sign-in challenge. The table has no foreign key, so
    // deactivation does not remove the row; it lives until the worker's 15-minute cleanup (10-minute challenge).
    const { address, created } = await enrolled();
    const b = browser();
    await b.post("/api/auth/sign-in", { email: address, password: PASSWORD });
    await deactivateLogin(app, address);
    const leftovers = await migrator.selectFrom("auth_verifications").select("identifier").where("value", "=", created.userId).execute();
    expect(leftovers).toEqual([]);
  });

  it("the email is stored nowhere after deactivation: not in any table, audit details included (the name stays only in the person's own record)", async () => {
    const { address } = await enrolled();
    expect(await everyRowAsText()).toContain(address); // sanity: the scan finds it while the login exists
    await deactivateLogin(app, address);
    const text = await everyRowAsText();
    expect(text).not.toContain(address);
    expect(text).not.toContain(address.split("@")[0]!);
    const nameHits = text.split("\n").filter((l) => l.includes(NAME)).map((l) => l.split(":")[0]);
    expect([...new Set(nameHits)].every((t) => t === "people"), `the name appears in: ${[...new Set(nameHits)].join(", ")}`).toBe(true);
  });

  it("the audit log never holds the email, the name, a password, a code or a token, for any action", async () => {
    const { address, secret, backupCodes } = await enrolled();
    const b = browser();
    await b.post("/api/auth/sign-in", { email: address, password: "wrong password here" });
    await b.post("/api/auth/sign-in", { email: address, password: PASSWORD });
    await b.post("/api/auth/two-factor/totp", { code: "000000" });
    await b.post("/api/auth/two-factor/backup-code", { code: backupCodes[0] });
    await b.post("/api/auth/sign-out");
    const rows = (await rawQuery<{ t: string }>(fresh.adminUrl, "select a::text as t from audit_log a")).map((r) => r.t).join("\n");
    for (const needle of [address, NAME, PASSWORD, secret, ...backupCodes, "wrong password here"]) expect(rows.includes(needle), needle.slice(0, 8)).toBe(false);
  });

  it("a person whose sign-in is in flight when they are deactivated cannot finish it: the right code gets no session", async () => {
    const { address, secret } = await enrolled();
    const b = browser();
    expect((await b.post("/api/auth/sign-in", { email: address, password: PASSWORD })).body).toEqual({ next: "code" });
    await deactivateLogin(app, address);
    const res = await b.post("/api/auth/two-factor/totp", { code: totpCode(secret, Date.now(), 1) });
    expect(res.status).toBe(401);
    expect((await auth.session(b.headers())).status).toBe("signed-out");
  });

  it("a password-only session ends when the person is deactivated: enrolment can't be finished afterwards", async () => {
    const address = `half-${randomUUID().slice(0, 8)}@example.org`;
    const created = await createLogin(app, { email: address, name: NAME, role: "member" });
    const b = browser();
    const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
    const secret = secretFromUri((setup.body.enrolment as { totpUri: string }).totpUri);
    await deactivateLogin(app, address);
    const res = await b.post("/api/auth/setup/confirm", { code: totpCode(secret) });
    expect(res.status).toBe(401);
    expect((await auth.session(b.headers())).status).toBe("signed-out");
  });

  it("a new login for a deactivated person's email starts clean: no old sessions, password, authenticator or codes carry over", async () => {
    const first = await enrolled();
    await deactivateLogin(app, first.address);
    const again = await createLogin(app, { email: first.address, name: NAME, role: "member" });
    expect(again.userId).not.toBe(first.created.userId);
    const b = browser();
    expect((await b.post("/api/auth/sign-in", { email: first.address, password: PASSWORD })).status).toBe(401); // no password yet
    expect((await auth.session(first.b.headers())).status).toBe("signed-out");
    const row = await migrator.selectFrom("auth_two_factors").select("id").where("user_id", "=", again.userId).execute();
    expect(row).toEqual([]);
  });
});

describe("ip_prefix and the audit events", () => {
  const trusted = { "cf-connecting-ip": "203.0.113.200" };

  it("only the four attempt events carry an ip_prefix, as a /24, whatever header is sent; every other event carries none", async () => {
    const mark = Number((await migrator.selectFrom("audit_log").select(sql<string>`coalesce(max(id), 0)`.as("m")).executeTakeFirstOrThrow()).m);
    const address = `ip-${randomUUID().slice(0, 8)}@example.org`;
    const created = await createLogin(app, { email: address, name: NAME, role: "member" });
    const b = browser(authIp, trusted);
    const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD }); // password_changed
    const secret = secretFromUri((setup.body.enrolment as { totpUri: string }).totpUri);
    const codes = (setup.body.enrolment as { backupCodes: string[] }).backupCodes;
    await b.post("/api/auth/setup/confirm", { code: totpCode(secret) }); // 2fa_enrolled, sign_in
    const second = browser(authIp, trusted);
    await second.post("/api/auth/sign-in", { email: address, password: "wrong password here" }); // sign_in_failed
    await second.post("/api/auth/sign-in", { email: address, password: PASSWORD });
    await second.post("/api/auth/two-factor/totp", { code: "000000" }); // 2fa_failed
    await second.post("/api/auth/two-factor/backup-code", { code: codes[0] }); // backup_code_used (+ sign_in)
    await second.post("/api/auth/sign-out"); // sign_out
    const third = browser(authIp, trusted);
    await third.post("/api/auth/sign-in", { email: address, password: PASSWORD });
    await third.post("/api/auth/two-factor/totp", { code: totpCode(secret, Date.now(), 1) });
    await third.post("/api/auth/sign-out-everywhere");

    const rows = await migrator.selectFrom("audit_log").select(["action", "ip_prefix"]).where("id", ">", mark as never).where("actor_user_id", "=", created.userId).execute();
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["password_changed", "2fa_enrolled", "sign_in", "sign_in_failed", "2fa_failed", "backup_code_used", "sign_out"]) expect(actions.has(a as never), a).toBe(true);
    const withIp = new Set(["sign_in", "sign_in_failed", "2fa_failed", "backup_code_used"]);
    for (const r of rows) {
      if (withIp.has(r.action)) expect(r.ip_prefix, r.action).toBe("203.0.113.0/24");
      else expect(r.ip_prefix, r.action).toBeNull();
    }
    expect(JSON.stringify(rows)).not.toContain("203.0.113.200");
  });

  it("the database itself refuses an ip_prefix on any other event, a host-length prefix, or a prefix that is not a /24 or /48 (defence in depth)", async () => {
    for (const [action, prefix] of [["sign_out", "203.0.113.0/24"], ["2fa_enrolled", "203.0.113.0/24"], ["password_changed", "203.0.113.0/24"], ["sign_in", "203.0.113.5/32"], ["sign_in", "203.0.113.0/16"], ["sign_in", "2001:db8::1/128"], ["sign_in", "not an ip"]]) {
      await expect(sql`insert into audit_log (action, ip_prefix) values (${action}, ${prefix})`.execute(app), `${action} ${prefix}`).rejects.toThrow();
    }
    await expect(sql`insert into audit_log (action, ip_prefix) values ('sign_in', '203.0.113.0/24')`.execute(app)).resolves.toBeDefined();
  });

  it("the sign-in application can add audit rows but not rewrite or remove them", async () => {
    await expect(sql`update audit_log set ip_prefix = null where action = 'sign_in'`.execute(app)).rejects.toThrow();
    await expect(sql`delete from audit_log where action = 'sign_in'`.execute(app)).rejects.toThrow();
    await expect(sql`update audit_log set actor_user_id = null`.execute(app)).rejects.toThrow();
  });
});

describe("what the application login may do to the auth tables", () => {
  it("vault_app can't delete users, can't read another table's secrets through the audit log, and can't create tables or roles", async () => {
    await expect(sql`delete from users`.execute(app)).rejects.toThrow();
    await expect(sql`create table sneaky (x int)`.execute(app)).rejects.toThrow();
    await expect(sql`create role sneaky login`.execute(app)).rejects.toThrow();
    await expect(sql`alter table auth_users disable trigger all`.execute(app)).rejects.toThrow();
  });

  it("a session row, a two-factor row and a credential row can't be created for a user that doesn't exist (foreign keys hold)", async () => {
    const ghost = randomUUID();
    await expect(sql`insert into auth_sessions (expires_at, token, user_id) values (now(), ${randomUUID()}, ${ghost})`.execute(app)).rejects.toThrow();
    await expect(sql`insert into auth_two_factors (secret, backup_codes, user_id) values ('s', '[]', ${ghost})`.execute(app)).rejects.toThrow();
    await expect(sql`insert into auth_accounts (account_id, provider_id, user_id) values ('a', 'credential', ${ghost})`.execute(app)).rejects.toThrow();
  });

  it("no sign-in table keeps a plain-text email beyond auth_users, and the setup token and backup codes are not stored in the clear", async () => {
    const address = `plain-${randomUUID().slice(0, 8)}@example.org`;
    const created = await createLogin(app, { email: address, name: NAME, role: "member" });
    const b = browser();
    const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
    const enrolment = setup.body.enrolment as { totpUri: string; backupCodes: string[] };
    const secret = secretFromUri(enrolment.totpUri);
    await b.post("/api/auth/sign-in", { email: address, password: "wrong password here" });
    const dump = await everyRowAsText(["auth_users", "people"]);
    for (const needle of [address, created.setupToken, secret, ...enrolment.backupCodes, PASSWORD, "wrong password here"]) expect(dump.includes(needle), needle.slice(0, 8)).toBe(false);
  });
});

describe("logs", () => {
  it("nothing the service logged while this file ran holds an email, a name, a password, a code, a token or a cookie", () => {
    const text = logged.join("\n");
    expect(text).not.toMatch(/@example\.org/);
    expect(text).not.toContain(NAME);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toMatch(/session_token|two_factor|Key \(|violates/i);
  });
});
