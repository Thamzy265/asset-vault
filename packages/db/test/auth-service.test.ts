import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthService, type AuthService } from "../src/auth/service.ts";
import { createLogin } from "../src/auth/logins.ts";
import { createDb } from "../src/client.ts";
import { migrateUp } from "../src/migrate.ts";
import type { Database } from "../src/schema.ts";
import { TestBrowser } from "./support/auth-client.ts";
import { freshDatabase, type FreshDatabase } from "./support/fresh-database.ts";
import { secretFromUri, totpCode } from "./support/totp.ts";

// M1.3 sign-in with mandatory 2FA: the auth service behind /api/auth/*, against a real
// database as vault_app (like the web app). Copy and states: docs/ui/m1-3-sign-in.md.
const KEY = "test-encryption-key-".padEnd(48, "x");
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery";

let fresh: FreshDatabase;
let migrator: Kysely<Database>;
let app: Kysely<Database>;
let auth: AuthService;
let authWithIp: AuthService;
let logged: string[];

beforeAll(async () => {
  fresh = await freshDatabase();
  migrator = createDb(fresh.url);
  await migrateUp(migrator);
  app = createDb(fresh.appUrl);
  logged = [];
  const log = (level: string, msg: string, fields?: Record<string, unknown>) => void logged.push(JSON.stringify({ level, msg, ...fields }));
  auth = createAuthService(app, { appUrl: ORIGIN, encryptionKey: KEY, trustedIpHeader: null }, { log });
  authWithIp = createAuthService(app, { appUrl: ORIGIN, encryptionKey: KEY, trustedIpHeader: "cf-connecting-ip" }, { log });
});
afterAll(async () => {
  await app?.destroy();
  await migrator?.destroy();
  await fresh?.drop();
});
beforeEach(async () => {
  // Rate-limit windows are per test: each test starts with no recent failures.
  await migrator.deleteFrom("auth_sign_in_failures").execute();
});

const browser = (service: AuthService = auth, headers: Record<string, string> = {}) => new TestBrowser((r) => service.handle(r), ORIGIN, headers);
const email = () => `user-${randomUUID().slice(0, 8)}@example.org`;

type Enrolment = { totpUri: string; secret: string; backupCodes: string[] };

/** pnpm user:create, then the person follows the setup link: password, authenticator, confirm. */
async function enrolledUser(role: "admin" | "member" = "member") {
  const address = email();
  const created = await createLogin(app, { email: address, name: "Test Person", role });
  const b = browser();
  const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
  expect(setup.status).toBe(200);
  const enrolment = setup.body.enrolment as Enrolment;
  const secret = secretFromUri(enrolment.totpUri);
  const confirm = await b.post("/api/auth/setup/confirm", { code: totpCode(secret) });
  expect(confirm.status).toBe(200);
  return { email: address, userId: created.userId, personId: created.personId, secret, backupCodes: enrolment.backupCodes, browser: b };
}

const auditFor = async (userId: string | null, action?: string) => {
  let q = migrator.selectFrom("audit_log").select(["action", "actor_user_id", "ip_prefix", "entity_type", "entity_id", "details"]).orderBy("id");
  q = userId === null ? q.where("actor_user_id", "is", null) : q.where("actor_user_id", "=", userId);
  if (action) q = q.where("action", "=", action as never);
  return q.execute();
};

describe("first-time setup via the setup link", () => {
  it("a valid link checks out; password -> authenticator -> confirm code signs the person in with 2FA passed", async () => {
    const address = email();
    const created = await createLogin(app, { email: address, name: "Ada", role: "admin" });
    const b = browser();
    expect((await b.post("/api/auth/setup/check", { token: created.setupToken })).status).toBe(200);

    const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
    expect(setup.status).toBe(200);
    const enrolment = setup.body.enrolment as Enrolment;
    expect(enrolment.totpUri).toMatch(/^otpauth:\/\/totp\/Family%20Asset%20Vault:/);
    expect(enrolment.secret).toBe(secretFromUri(enrolment.totpUri));
    expect(enrolment.backupCodes).toHaveLength(10);

    // Password set, 2FA not yet: the session exists but reaches nothing (403 2fa_required).
    expect((await auth.session(b.headers())).status).toBe("two-factor-required");

    const confirm = await b.post("/api/auth/setup/confirm", { code: totpCode(enrolment.secret) });
    expect(confirm.status).toBe(200);
    const state = await auth.session(b.headers());
    expect(state.status).toBe("signed-in");
    if (state.status !== "signed-in") return;
    expect(state.user).toEqual({ id: created.userId, name: "Ada", role: "admin", personId: created.personId });
    expect(state.viewer).toMatchObject({ userId: created.userId, role: "admin", personId: created.personId });
    expect(Object.isFrozen(state.viewer)).toBe(true);

    const actions = (await auditFor(created.userId)).map((r) => r.action);
    expect(actions).toEqual(["password_changed", "2fa_enrolled", "sign_in"]);
  });

  it("the link is used up when 2FA enrolment is confirmed, not at the password step; a made-up or expired link never works", async () => {
    const created = await createLogin(app, { email: email(), name: "Bo", role: "member" });
    const b = browser();
    expect((await b.post("/api/auth/setup/check", { token: created.setupToken })).body).toEqual({ valid: true, step: 1 });
    const first = await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
    expect(first.status).toBe(200);
    // Password set, authenticator not confirmed: the link still opens, at step 2, and cannot set a second password.
    expect((await browser().post("/api/auth/setup/check", { token: created.setupToken })).body).toEqual({ valid: true, step: 2 });
    const second = await browser().post("/api/auth/setup/password", { token: created.setupToken, password: "another long passphrase" });
    expect(second.status).toBe(410);
    expect(second.response.headers.getSetCookie()).toEqual([]);
    // Confirming enrolment uses it up.
    const secret = (first.body.enrolment as Enrolment).secret;
    expect((await b.post("/api/auth/setup/confirm", { code: totpCode(secret) })).status).toBe(200);
    for (const token of [created.setupToken, "made-up-token", ""]) {
      const res = await browser().post("/api/auth/setup/check", { token });
      expect(res.status, token).toBe(410);
      expect(res.body).toEqual({ error: { code: "link_invalid", message: expect.any(String) } });
      expect((await browser().post("/api/auth/setup/password", { token, password: PASSWORD })).status, token).toBe(410);
      expect((await browser().post("/api/auth/setup/resume", { token })).status, token).toBe(410);
    }
    const expired = await createLogin(app, { email: email(), name: "Cy", role: "member" });
    await migrator.updateTable("auth_setup_tokens").set({ expires_at: new Date(Date.now() - 1000) }).where("user_id", "=", expired.userId).execute();
    expect((await browser().post("/api/auth/setup/check", { token: expired.setupToken })).status).toBe(410);
  });

  it("opening the link again after step 1 resumes at step 2 with the password kept: a new secret, backup codes and session, the old ones replaced", async () => {
    const address = email();
    const created = await createLogin(app, { email: address, name: "Re", role: "member" });
    const first = browser();
    const step1 = await first.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
    const oldSecret = (step1.body.enrolment as Enrolment).secret;
    const again = browser();
    const resumed = await again.post("/api/auth/setup/resume", { token: created.setupToken });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    const enrolment = resumed.body.enrolment as Enrolment;
    expect(enrolment.secret).not.toBe(oldSecret);
    expect(enrolment.backupCodes).toHaveLength(10);
    expect(new URL(enrolment.totpUri).searchParams.get("secret")).toBe(enrolment.secret);
    expect((await auth.session(again.headers())).status).toBe("two-factor-required");
    expect((await auth.session(first.headers())).status).toBe("signed-out"); // the earlier password-only session is gone
    expect((await first.post("/api/auth/setup/confirm", { code: totpCode(oldSecret) })).status).toBe(401);
    expect((await again.post("/api/auth/setup/confirm", { code: totpCode(enrolment.secret) })).status).toBe(200);
    // The password set at step 1 is the one that works, with the new authenticator.
    const b = browser();
    expect((await b.post("/api/auth/sign-in", { email: address, password: PASSWORD })).body).toEqual({ next: "code" });
    expect((await b.post("/api/auth/two-factor/totp", { code: totpCode(enrolment.secret, Date.now(), 1) })).status).toBe(200);
  });

  it("resume refuses a link whose password step was never done, and a made-up link", async () => {
    const created = await createLogin(app, { email: email(), name: "Early", role: "member" });
    const b = browser();
    const res = await b.post("/api/auth/setup/resume", { token: created.setupToken });
    expect(res.status).toBe(400);
    expect(b.cookies.size).toBe(0);
    expect((await b.post("/api/auth/setup/resume", { token: "x".repeat(43) })).status).toBe(410);
    expect((await b.post("/api/auth/setup/resume", {})).status).toBe(400);
  });

  it("the password alone never resumes setup or hands out a secret: it gets the 'setup isn't finished' answer, no cookie, no session", async () => {
    const address = email();
    const created = await createLogin(app, { email: address, name: "Half", role: "member" });
    await browser().post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
    await migrator.deleteFrom("auth_sessions").where("user_id", "=", created.userId).execute();
    const b = browser();
    const res = await b.post("/api/auth/sign-in", { email: address, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "setup_unfinished", message: "Your account setup isn't finished. Open your setup link again, or ask your admin for a new one." } });
    expect(JSON.stringify(res.body)).not.toMatch(/otpauth|secret|backup/i);
    expect(res.response.headers.getSetCookie()).toEqual([]);
    expect(await migrator.selectFrom("auth_sessions").select("id").where("user_id", "=", created.userId).execute()).toEqual([]);
    // It is still a right password, so it does not count as a failure.
    expect(await migrator.selectFrom("auth_sign_in_failures").select("id").execute()).toEqual([]);
    // The link still works.
    expect((await browser().post("/api/auth/setup/check", { token: created.setupToken })).body).toEqual({ valid: true, step: 2 });
  });

  it("only the hash of the setup token is stored, and it expires 24 h after it was issued", async () => {
    const created = await createLogin(app, { email: email(), name: "Di", role: "member" });
    const row = await migrator.selectFrom("auth_setup_tokens").selectAll().where("user_id", "=", created.userId).executeTakeFirstOrThrow();
    expect(row.token_hash).not.toContain(created.setupToken);
    expect(row.token_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hours = (row.expires_at.getTime() - row.created_at.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(24, 1);
  });

  it.each([
    ["too short", "elevenchars", "password_too_short"],
    ["too common", "password1234", "password_too_common"],
    ["too common, in another case", "Password1234", "password_too_common"],
    ["too long", "x".repeat(129), "password_too_long"],
  ])("refuses a password that is %s and keeps the link usable", async (_label, password, code) => {
    const created = await createLogin(app, { email: email(), name: "Ed", role: "member" });
    const res = await browser().post("/api/auth/setup/password", { token: created.setupToken, password });
    expect(res.status).toBe(400);
    expect((res.body.error as { code: string }).code).toBe(code);
    expect((await browser().post("/api/auth/setup/check", { token: created.setupToken })).status).toBe(200);
  });

  it("a wrong confirmation code is refused and audited as 2fa_failed; the user stays unenrolled", async () => {
    const created = await createLogin(app, { email: email(), name: "Flo", role: "member" });
    const b = browser();
    const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
    const secret = (setup.body.enrolment as Enrolment).secret;
    const wrong = totpCode(secret) === "000000" ? "111111" : "000000";
    const res = await b.post("/api/auth/setup/confirm", { code: wrong });
    expect(res.status).toBe(401);
    expect((res.body.error as { code: string }).code).toBe("invalid_code");
    expect((await auth.session(b.headers())).status).toBe("two-factor-required");
    expect((await auditFor(created.userId, "2fa_failed")).length).toBe(1);
  });

  it("confirming enrolment ends every other session of that user (a password-only session can't ride along)", async () => {
    const created = await createLogin(app, { email: email(), name: "Gus", role: "member" });
    const setupBrowser = browser();
    await setupBrowser.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
    // A second device opens the same link: it resumes at step 2 with a new secret (and ends the first password-only session).
    const other = browser();
    const resumed = await other.post("/api/auth/setup/resume", { token: created.setupToken });
    expect((await auth.session(other.headers())).status).toBe("two-factor-required");
    const secret = (resumed.body.enrolment as Enrolment).secret;
    // A third password-only session appears (the first device opens the link again) and is ended by the confirm.
    const third = browser();
    const thirdSecret = ((await third.post("/api/auth/setup/resume", { token: created.setupToken })).body.enrolment as Enrolment).secret;
    expect(thirdSecret).not.toBe(secret);
    expect((await auth.session(other.headers())).status).toBe("signed-out");
    expect((await third.post("/api/auth/setup/confirm", { code: totpCode(thirdSecret) })).status).toBe(200);
    expect((await auth.session(third.headers())).status).toBe("signed-in");
    expect(await migrator.selectFrom("auth_sessions").select("id").where("user_id", "=", created.userId).execute()).toHaveLength(1);
  });

  it("re-issuing a setup link ends every session at once and clears the old 2FA and backup codes; the old link is dead", async () => {
    const user = await enrolledUser();
    const second = browser();
    await second.post("/api/auth/sign-in", { email: user.email, password: PASSWORD });
    await second.post("/api/auth/two-factor/totp", { code: totpCode(user.secret, Date.now(), 1) });
    const midFlight = browser();
    await midFlight.post("/api/auth/sign-in", { email: user.email, password: PASSWORD }); // a sign-in challenge in flight
    expect((await auth.session(user.browser.headers())).status).toBe("signed-in");

    const again = await createLogin(app, { email: user.email, name: "Test Person", role: "member" });
    expect(again.reissued).toBe(true);
    expect(again.userId).toBe(user.userId);
    expect((await migrator.selectFrom("auth_setup_tokens").select("id").where("user_id", "=", user.userId).execute()).length).toBe(1);

    // Before the new link is used: every device is signed out, 2FA and backup codes are gone, the challenge is dead.
    expect((await auth.session(user.browser.headers())).status).toBe("signed-out");
    expect((await auth.session(second.headers())).status).toBe("signed-out");
    expect(await migrator.selectFrom("auth_sessions").select("id").where("user_id", "=", user.userId).execute()).toEqual([]);
    expect(await migrator.selectFrom("auth_two_factors").select("id").where("user_id", "=", user.userId).execute()).toEqual([]);
    expect((await migrator.selectFrom("auth_users").select("two_factor_enabled").where("id", "=", user.userId).executeTakeFirstOrThrow()).two_factor_enabled).toBe(false);
    expect(await migrator.selectFrom("auth_verifications").select("identifier").where("value", "=", user.userId).execute()).toEqual([]);
    expect((await midFlight.post("/api/auth/two-factor/totp", { code: totpCode(user.secret, Date.now(), -1) })).status).toBe(401);
    // The old password gets no session and no secret: setup isn't finished.
    const old = await browser().post("/api/auth/sign-in", { email: user.email, password: PASSWORD });
    expect(old.status).toBe(403);
    expect((old.body.error as { code: string }).code).toBe("setup_unfinished");

    // Using the new link sets a new password.
    const b = browser();
    expect((await b.post("/api/auth/setup/password", { token: again.setupToken, password: "a brand new passphrase" })).status).toBe(200);
    expect((await browser().post("/api/auth/sign-in", { email: user.email, password: PASSWORD })).status).toBe(401);
  });
});

describe("daily sign-in", () => {
  it("email + password, then the 6-digit code: signed in, audited with no IP when no trusted header is set", async () => {
    const user = await enrolledUser();
    const b = browser();
    const step1 = await b.post("/api/auth/sign-in", { email: user.email, password: PASSWORD });
    expect(step1.status).toBe(200);
    expect(step1.body).toEqual({ next: "code" });
    // Password alone gives no session.
    expect((await auth.session(b.headers())).status).toBe("signed-out");
    const step2 = await b.post("/api/auth/two-factor/totp", { code: totpCode(user.secret, Date.now(), 1) });
    expect(step2.status).toBe(200);
    expect(step2.body).toEqual({ next: "home" });
    expect((await auth.session(b.headers())).status).toBe("signed-in");
    const signIns = await auditFor(user.userId, "sign_in");
    expect(signIns.at(-1)).toMatchObject({ action: "sign_in", ip_prefix: null, entity_id: null, details: null });
  });

  it("the email is matched case-insensitively and surrounding spaces are ignored", async () => {
    const user = await enrolledUser();
    const res = await browser().post("/api/auth/sign-in", { email: `  ${user.email.toUpperCase()} `, password: PASSWORD });
    expect(res.body).toEqual({ next: "code" });
  });

  it("with a trusted IP header, sign_in and sign_in_failed carry the /24 (IPv4) or /48 (IPv6) prefix, never the address", async () => {
    const user = await enrolledUser();
    const v4 = browser(authWithIp, { "cf-connecting-ip": "203.0.113.77", "x-forwarded-for": "198.51.100.1" });
    await v4.post("/api/auth/sign-in", { email: user.email, password: "wrong password here" });
    await v4.post("/api/auth/sign-in", { email: user.email, password: PASSWORD });
    await v4.post("/api/auth/two-factor/totp", { code: totpCode(user.secret, Date.now(), 1) });
    const v6 = browser(authWithIp, { "cf-connecting-ip": "2001:db8:abcd:12::1" });
    await v6.post("/api/auth/sign-in", { email: user.email, password: "wrong password here" });
    const rows = await auditFor(user.userId);
    expect(rows.filter((r) => r.action === "sign_in_failed").map((r) => r.ip_prefix)).toEqual(["203.0.113.0/24", "2001:db8:abcd::/48"]);
    expect(rows.filter((r) => r.action === "sign_in").at(-1)?.ip_prefix).toBe("203.0.113.0/24");
    expect(JSON.stringify(rows)).not.toContain("198.51.100");
  });

  it("wrong password and unknown email get the same answer; both are audited without the email", async () => {
    const user = await enrolledUser();
    const wrong = await browser().post("/api/auth/sign-in", { email: user.email, password: "not the password" });
    const unknown = await browser().post("/api/auth/sign-in", { email: email(), password: "not the password" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body).toEqual({ error: { code: "invalid_credentials", message: "Email or password is not right." } });
    expect((await auditFor(user.userId, "sign_in_failed")).length).toBe(1);
    const all = JSON.stringify(await migrator.selectFrom("audit_log").selectAll().execute());
    expect(all).not.toContain("@example.org");
  });

  it("unknown email and wrong password take a similar time (the password is hashed either way)", async () => {
    const user = await enrolledUser();
    const time = async (address: string) => {
      const start = performance.now();
      await browser().post("/api/auth/sign-in", { email: address, password: "not the password" });
      return performance.now() - start;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 3; i++) {
      known.push(await time(user.email));
      unknown.push(await time(email()));
    }
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[1]!;
    const ratio = median(known) / median(unknown);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("a wrong code is refused with the spec's error; after 5 wrong codes the person must sign in again", async () => {
    const user = await enrolledUser();
    const b = browser();
    await b.post("/api/auth/sign-in", { email: user.email, password: PASSWORD });
    const right = totpCode(user.secret);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 1; i <= 4; i++) {
      const res = await b.post("/api/auth/two-factor/totp", { code: wrong });
      expect(res.status, `attempt ${i}`).toBe(401);
      expect(res.body, `attempt ${i}`).toEqual({ error: { code: "invalid_code", message: expect.any(String) } });
    }
    const fifth = await b.post("/api/auth/two-factor/totp", { code: wrong });
    expect(fifth.status).toBe(401);
    expect((fifth.body.error as { code: string }).code).toBe("sign_in_again");
    // Even the right code is refused now: the challenge is gone.
    const after = await b.post("/api/auth/two-factor/totp", { code: right });
    expect((after.body.error as { code: string }).code).toBe("sign_in_again");
    expect((await auditFor(user.userId, "2fa_failed")).length).toBe(5);
  });

  it("a code from one step either side (clock drift) is accepted", async () => {
    const user = await enrolledUser();
    const b = browser();
    await b.post("/api/auth/sign-in", { email: user.email, password: PASSWORD });
    expect((await b.post("/api/auth/two-factor/totp", { code: totpCode(user.secret, Date.now(), -1) })).status).toBe(200);
  });

  it("a backup code works once, says how many are left, and is audited as backup_code_used", async () => {
    const user = await enrolledUser();
    const b = browser();
    await b.post("/api/auth/sign-in", { email: user.email, password: PASSWORD });
    const ok = await b.post("/api/auth/two-factor/backup-code", { code: ` ${user.backupCodes[0]} ` });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ next: "home", backupCodesLeft: 9 });
    expect((await auth.session(b.headers())).status).toBe("signed-in");
    const again = browser();
    await again.post("/api/auth/sign-in", { email: user.email, password: PASSWORD });
    const reused = await again.post("/api/auth/two-factor/backup-code", { code: user.backupCodes[0] });
    expect(reused.status).toBe(401);
    expect((reused.body.error as { code: string }).code).toBe("invalid_backup_code");
    expect((await auditFor(user.userId, "backup_code_used")).length).toBe(1);
  });

  it("the TOTP secret is stored encrypted, backup codes as keyed hashes, the password as a scrypt hash", async () => {
    const user = await enrolledUser();
    const tf = await migrator.selectFrom("auth_two_factors").selectAll().where("user_id", "=", user.userId).executeTakeFirstOrThrow();
    expect(tf.secret).not.toContain(user.secret);
    for (const code of user.backupCodes) expect(tf.backup_codes).not.toContain(code);
    expect(JSON.parse(tf.backup_codes)).toHaveLength(10);
    const account = await migrator.selectFrom("auth_accounts").selectAll().where("user_id", "=", user.userId).executeTakeFirstOrThrow();
    expect(account.provider_id).toBe("credential");
    expect(account.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
  });
});

describe("rate limits", () => {
  it("5 failed passwords for an account: the 6th try is 429 with the retry time, even with the right password", async () => {
    const user = await enrolledUser();
    for (let i = 0; i < 5; i++) expect((await browser().post("/api/auth/sign-in", { email: user.email, password: `wrong ${i} password` })).status).toBe(401);
    const limited = await browser().post("/api/auth/sign-in", { email: user.email, password: PASSWORD });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: { code: "rate_limited", message: "Too many tries. Try again in 15 minutes.", retryAfterSeconds: expect.any(Number) } });
    expect(limited.response.headers.get("retry-after")).toBe(String((limited.body.error as { retryAfterSeconds: number }).retryAfterSeconds));
  });

  it("an unknown email is limited the same way (no way to tell which emails exist)", async () => {
    const nobody = email();
    for (let i = 0; i < 5; i++) await browser().post("/api/auth/sign-in", { email: nobody, password: `wrong ${i} password` });
    expect((await browser().post("/api/auth/sign-in", { email: nobody, password: "whatever password" })).status).toBe(429);
  });

  it("20 failures from one IP prefix in 15 minutes: further tries from that prefix are 429, other prefixes are not", async () => {
    const user = await enrolledUser();
    for (let i = 0; i < 20; i++) {
      await browser(authWithIp, { "cf-connecting-ip": `198.51.100.${i + 1}` }).post("/api/auth/sign-in", { email: email(), password: "wrong password!" });
    }
    expect((await browser(authWithIp, { "cf-connecting-ip": "198.51.100.200" }).post("/api/auth/sign-in", { email: user.email, password: PASSWORD })).status).toBe(429);
    expect((await browser(authWithIp, { "cf-connecting-ip": "192.0.2.10" }).post("/api/auth/sign-in", { email: user.email, password: PASSWORD })).status).toBe(200);
  });

  it("failures older than 15 minutes no longer count, and are deleted", async () => {
    const user = await enrolledUser();
    for (let i = 0; i < 5; i++) await browser().post("/api/auth/sign-in", { email: user.email, password: `wrong ${i} password` });
    await sql`update auth_sign_in_failures set at = now() - interval '16 minutes'`.execute(migrator);
    expect((await browser().post("/api/auth/sign-in", { email: user.email, password: PASSWORD })).status).toBe(200);
    await browser().post("/api/auth/sign-in", { email: user.email, password: "one more wrong one" });
    const left = await migrator.selectFrom("auth_sign_in_failures").select("at").execute();
    expect(left.length).toBe(1);
  });

  it("the failure log holds no email and no full IP address", async () => {
    await browser(authWithIp, { "cf-connecting-ip": "203.0.113.9" }).post("/api/auth/sign-in", { email: "someone@example.org", password: "wrong password!" });
    const rows = JSON.stringify(await migrator.selectFrom("auth_sign_in_failures").selectAll().execute());
    expect(rows).not.toContain("someone");
    expect(rows).not.toContain("203.0.113.9");
    expect(rows).toContain("203.0.113.0/24");
  });
});

describe("sessions", () => {
  it("an idle-expired session is 'ended' (the sign-in screen says so)", async () => {
    const user = await enrolledUser();
    await migrator.updateTable("auth_sessions").set({ expires_at: new Date(Date.now() - 1000) }).where("user_id", "=", user.userId).execute();
    expect(await auth.session(user.browser.headers())).toMatchObject({ status: "signed-out", reason: "ended" });
  });

  it("a session older than 7 days ends even while in use, and its row is deleted", async () => {
    const user = await enrolledUser();
    await migrator.updateTable("auth_sessions").set({ created_at: new Date(Date.now() - 7 * 86_400_000 - 1000) }).where("user_id", "=", user.userId).execute();
    expect(await auth.session(user.browser.headers())).toMatchObject({ status: "signed-out", reason: "ended" });
    expect(await migrator.selectFrom("auth_sessions").select("id").where("user_id", "=", user.userId).execute()).toEqual([]);
  });

  it("item b: a deactivated user is refused on the very next request, and their sessions are deleted", async () => {
    const user = await enrolledUser();
    await migrator.updateTable("users").set({ deactivated_at: new Date() }).where("id", "=", user.userId).execute();
    expect(await auth.session(user.browser.headers())).toMatchObject({ status: "signed-out", reason: "ended" });
    expect(await migrator.selectFrom("auth_sessions").select("id").where("user_id", "=", user.userId).execute()).toEqual([]);
  });

  it("no cookie at all is 'signed-out' with no reason; a forged cookie is the same", async () => {
    expect(await auth.session(new Headers())).toEqual({ status: "signed-out", reason: "none", setCookies: [] });
    const forged = new Headers({ cookie: "__Secure-vault.session_token=abc.def" });
    expect((await auth.session(forged)).status).toBe("signed-out");
  });

  it("sign out ends this session, clears the cookie and is audited", async () => {
    const user = await enrolledUser();
    const res = await user.browser.post("/api/auth/sign-out");
    expect(res.status).toBe(200);
    expect(res.response.headers.getSetCookie().join("\n")).toMatch(/session_token=;.*Max-Age=0/i);
    expect((await auth.session(user.browser.headers())).status).toBe("signed-out");
    expect((await auditFor(user.userId, "sign_out")).length).toBe(1);
  });

  it("sign out of all devices ends every session of the user", async () => {
    const user = await enrolledUser();
    const second = browser();
    await second.post("/api/auth/sign-in", { email: user.email, password: PASSWORD });
    await second.post("/api/auth/two-factor/totp", { code: totpCode(user.secret, Date.now(), 1) });
    expect((await auth.session(second.headers())).status).toBe("signed-in");
    expect((await user.browser.post("/api/auth/sign-out-everywhere")).status).toBe(200);
    expect((await auth.session(second.headers())).status).toBe("signed-out");
    expect((await auth.session(user.browser.headers())).status).toBe("signed-out");
  });

  it("session cookies are HttpOnly, Secure and SameSite=Lax", async () => {
    const user = await enrolledUser();
    const b = browser();
    await b.post("/api/auth/sign-in", { email: user.email, password: PASSWORD });
    const res = await b.post("/api/auth/two-factor/totp", { code: totpCode(user.secret, Date.now(), 1) });
    const cookie = res.response.headers.getSetCookie().find((c) => c.includes("session_token="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/^__Secure-/);
  });
});

describe("the auth endpoints' own surface", () => {
  it("refuses a cross-site POST (wrong or missing Origin) before doing anything", async () => {
    const created = await createLogin(app, { email: email(), name: "Hal", role: "member" });
    for (const origin of ["https://evil.example", "null", ""]) {
      const headers = new Headers({ "content-type": "application/json" });
      if (origin) headers.set("origin", origin);
      const res = await auth.handle(new Request(`${ORIGIN}/api/auth/setup/password`, { method: "POST", headers, body: JSON.stringify({ token: created.setupToken, password: PASSWORD }) }));
      expect(res.status, origin).toBe(403);
      expect(await res.json()).toEqual({ error: { code: "forbidden", message: expect.any(String) } });
    }
    expect((await browser().post("/api/auth/setup/check", { token: created.setupToken })).status).toBe(200);
  });

  it("only JSON POSTs: a form post is 415, GET is 405 with Allow: POST, an unknown path is 404", async () => {
    const form = await auth.handle(new Request(`${ORIGIN}/api/auth/sign-in`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: "email=a&password=b" }));
    expect(form.status).toBe(415);
    const get = await auth.handle(new Request(`${ORIGIN}/api/auth/sign-in`));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const unknown = await browser().post("/api/auth/sign-up/email", { email: email(), password: PASSWORD, name: "X" });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("there is no sign-up: no route creates a user", async () => {
    const before = Number((await migrator.selectFrom("users").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow()).n);
    for (const path of ["/api/auth/sign-up/email", "/api/auth/sign-up", "/api/auth/signup"]) await browser().post(path, { email: email(), password: PASSWORD, name: "X" });
    expect(Number((await migrator.selectFrom("users").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow()).n)).toBe(before);
  });

  it("malformed bodies are 400, never 500: missing fields, wrong types, not JSON, too large", async () => {
    const b = browser();
    for (const body of [{}, { email: 1, password: [] }, { email: "a@b.c" }]) {
      expect((await b.post("/api/auth/sign-in", body)).status, JSON.stringify(body)).toBe(400);
    }
    const notJson = await auth.handle(new Request(`${ORIGIN}/api/auth/sign-in`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{" }));
    expect(notJson.status).toBe(400);
    const huge = await auth.handle(new Request(`${ORIGIN}/api/auth/sign-in`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.c", password: "x".repeat(100_000) }) }));
    expect(huge.status).toBe(413);
  });

  it("nothing logged during these tests holds an email, a password, a code or a token (item e)", () => {
    const text = logged.join("\n");
    expect(text).not.toMatch(/@example\.org/);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toMatch(/"(token|password|email|secret)":/);
  });
});
