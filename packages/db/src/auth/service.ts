import { createHmac, timingSafeEqual } from "node:crypto";
import { betterAuth } from "better-auth";
import { generateRandomString, makeSignature, symmetricEncrypt } from "better-auth/crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { defaultRepositoryLog, type LogFn } from "../access.ts";
import { kyselyOf, type DbLike } from "../handle.ts";
import { errorCode } from "../log.ts";
import type { Database } from "../schema.ts";
import type { AuthConfig } from "./config.ts";
import { auditAuthEvent } from "./events.ts";
import { clientIpPrefix } from "./ip.ts";
import { APP_NAME, authOptions, BACKUP_CODE_COUNT, hashBackupCode } from "./options.ts";
import { passwordProblem } from "./passwords.ts";
import { accountKey, checkSignInLimit, ipKey, normaliseEmail, recordSignInFailure, retryMessage } from "./rate-limit.ts";
import { cookieValue, resolveSession, type SessionState } from "./session.ts";
import { deleteSetupTokens, lockSetupToken, peekSetupToken } from "./setup-tokens.ts";

/**
 * The sign-in service behind /api/auth/* (design note M1.3). It wraps Better
 * Auth and exposes only the steps the screens need; the library's own HTTP
 * handler (sign-up, email change, account linking, ...) is never mounted.
 *
 *   POST /api/auth/sign-in                 { email, password }
 *   POST /api/auth/two-factor/totp         { code }
 *   POST /api/auth/two-factor/backup-code  { code }
 *   POST /api/auth/setup/check             { token }             -> { valid, step: 1 | 2 }
 *   POST /api/auth/setup/password          { token, password }   (step 1)
 *   POST /api/auth/setup/resume            { token }             (step 2 again, from the link alone)
 *   POST /api/auth/setup/confirm           { code }
 *   POST /api/auth/sign-out
 *   POST /api/auth/sign-out-everywhere
 *
 * Every endpoint takes a same-origin JSON POST only (CSRF: Origin must be
 * APP_URL). Errors use the API's shape { error: { code, message } }.
 * The setup link lives until 2FA enrolment is confirmed (24 h from issue) and is used up then
 * (lead decision 5). A password alone never resumes setup or hands out an authenticator secret.
 * Invariant: a session of a user with 2FA enabled was created by a passed 2FA
 * step (sign-in code, backup code, or confirming enrolment, which ends every
 * other session), so session.ts may treat "2FA enabled" as "2FA passed".
 */
export type AuthService = {
  handle: (request: Request) => Promise<Response>;
  session: (headers: Headers) => Promise<SessionState>;
};

export type AuthServiceOptions = { log?: LogFn };

const MAX_BODY_BYTES = 8 * 1024;

const MESSAGES = {
  invalid_request: "The request is not valid.",
  invalid_credentials: "Email or password is not right.",
  invalid_code: "That code is not right.",
  invalid_backup_code: "That backup code is not right or was already used.",
  sign_in_again: "Please sign in again.",
  link_invalid: "This link has expired or was already used. Ask your admin for a new one.",
  setup_unfinished: "Your account setup isn't finished. Open your setup link again, or ask your admin for a new one.",
  password_too_short: "Use at least 12 characters.",
  password_too_long: "Use at most 128 characters.",
  password_too_common: "This password is too common — choose another.",
  unauthorized: "Sign in to continue.",
  forbidden: "This request was refused.",
  not_found: "No endpoint at this path.",
  method_not_allowed: "Use POST.",
  unsupported_media_type: "Send JSON.",
  payload_too_large: "The request is too large.",
  internal_error: "Something went wrong. Try again.",
} as const;
type ErrorCode = keyof typeof MESSAGES | "rate_limited";

class Reply {
  readonly cookies: string[] = [];
  addCookies(from: Response | string[]): this {
    this.cookies.push(...(Array.isArray(from) ? from : from.headers.getSetCookie()));
    return this;
  }
  json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
    const headers = new Headers({ "cache-control": "no-store", ...extra });
    for (const c of this.cookies) headers.append("set-cookie", c);
    return Response.json(body, { status, headers });
  }
  error(status: number, code: ErrorCode, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
    const message = code === "rate_limited" ? String(extra.message) : MESSAGES[code];
    const rest = Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "message"));
    return this.json(status, { error: { code, message, ...rest } }, headers);
  }
}

const credentials = z.object({ email: z.string().min(1).max(320), password: z.string().min(1) });
const codeBody = z.object({ code: z.string().min(1).max(64) });
const tokenBody = z.object({ token: z.string().max(200) });
const setupBody = z.object({ token: z.string().max(200), password: z.string() });

export function createAuthService(handle: DbLike, config: AuthConfig, options: AuthServiceOptions = {}): AuthService {
  const db: Kysely<Database> = kyselyOf(handle);
  const log = options.log ?? defaultRepositoryLog;
  const auth = betterAuth(
    authOptions(db, config, {
      // Item b, defence in depth: never create a session for a deactivated user.
      beforeSessionCreate: async (userId) => {
        const user = await db.selectFrom("users").select("deactivated_at").where("id", "=", userId).executeTakeFirst();
        return user !== undefined && user.deactivated_at === null;
      },
    }),
  );
  const context = auth.$context;
  const cookieName = async (name: "session_token" | "two_factor" | "session_data" | "dont_remember") => (await context).createAuthCookie(name).name;

  /** Set-Cookie values that delete the auth cookies. */
  async function clearCookies(): Promise<string[]> {
    const names = await Promise.all((["session_token", "session_data", "dont_remember"] as const).map(cookieName));
    return names.map((n) => `${n}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
  }

  async function session(headers: Headers): Promise<SessionState> {
    const sessionCookieName = await cookieName("session_token");
    const cleared = await clearCookies();
    return resolveSession(
      {
        db,
        sessionCookieName,
        clearCookies: () => cleared,
        getLibrarySession: async (h) => {
          const result = await auth.api.getSession({ headers: h, returnHeaders: true });
          const setCookies = result.headers.getSetCookie();
          const s = result.response;
          return { session: s ? { session: { token: s.session.token, userId: s.session.userId, createdAt: s.session.createdAt } } : null, setCookies };
        },
      },
      headers,
    );
  }

  async function libraryError(response: Response): Promise<string | undefined> {
    const body = (await response.clone().json().catch(() => null)) as { code?: string } | null;
    return body?.code;
  }

  /** The user behind this request's sign-in challenge (two_factor cookie), verified like the library does. */
  async function challenge(headers: Headers): Promise<{ id: string; userId: string } | null> {
    const raw = cookieValue(headers, await cookieName("two_factor"));
    if (!raw) return null;
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      return null;
    }
    const dot = value.lastIndexOf(".");
    if (dot < 1) return null;
    const id = value.slice(0, dot);
    const given = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(createHmac("sha256", config.encryptionKey).update(id).digest("base64"));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const row = await db.selectFrom("auth_verifications").select("value").where("identifier", "=", id).executeTakeFirst();
    return row ? { id, userId: row.value } : null;
  }

  /** Spec: after 5 wrong codes the person signs in again. The library counts per challenge; we end it on the 5th. */
  async function endChallengeIfSpent(c: { id: string }): Promise<boolean> {
    const attempts = await db.selectFrom("auth_verifications").select("value").where("identifier", "=", `2fa-attempts-${c.id}`).executeTakeFirst();
    if (!attempts || Number(attempts.value) < 5) return false;
    await db.deleteFrom("auth_verifications").where("identifier", "in", [c.id, `2fa-attempts-${c.id}`]).execute();
    return true;
  }

  async function twoFactorCookieCleared(): Promise<string> {
    return `${await cookieName("two_factor")}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
  }

  /**
   * A TOTP code is single use (RFC 6238 section 5.2; lead decision 4). The library accepts a code
   * for 3 steps (90 s), so a code that was accepted once is remembered for 3 minutes as a keyed
   * hash in auth_verifications (swept by the worker like any expired challenge). The claim is made
   * before the library checks the code, under a per-code lock, so two requests racing with one
   * code cannot both pass; a code that turns out wrong gives its claim back.
   */
  const totpMarker = (userId: string, code: string) =>
    `totp-used:${userId}:${createHmac("sha256", config.encryptionKey).update(`totp-code:${code}`).digest("base64url")}`;

  async function claimTotp(marker: string): Promise<boolean> {
    return db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${marker}, 0))`.execute(trx);
      await trx.deleteFrom("auth_verifications").where("identifier", "=", marker).where("expires_at", "<=", sql<Date>`now()`).execute();
      const taken = await trx.selectFrom("auth_verifications").select("id").where("identifier", "=", marker).executeTakeFirst();
      if (taken) return false;
      await trx.insertInto("auth_verifications").values({ identifier: marker, value: "used", expires_at: sql<Date>`now() + interval '3 minutes'` }).execute();
      return true;
    });
  }

  const releaseTotp = (marker: string) => db.deleteFrom("auth_verifications").where("identifier", "=", marker).execute();

  /** The library's account lock (10 failed codes in a row): reported as the same 429 as the password limit. */
  async function lockedReply(reply: Reply, userId: string | undefined): Promise<Response> {
    const row = userId ? await db.selectFrom("auth_two_factors").select("locked_until").where("user_id", "=", userId).executeTakeFirst() : undefined;
    const seconds = row?.locked_until ? Math.max(1, Math.ceil((row.locked_until.getTime() - Date.now()) / 1000)) : 15 * 60;
    return reply.error(429, "rate_limited", { message: retryMessage(seconds), retryAfterSeconds: seconds }, { "retry-after": String(seconds) });
  }

  /**
   * A new authenticator secret and backup codes for the user, stored unverified (replacing any earlier
   * ones). Written here rather than through the library's enable call, which asks for the password: the
   * setup link alone resumes step 2. Format and encryption are the library's, so its TOTP check and the
   * confirm step work on it unchanged.
   */
  async function createEnrolment(trx: Transaction<Database>, userId: string, email: string) {
    const secret = generateRandomString(32);
    const backupCodes = Array.from({ length: BACKUP_CODE_COUNT }, () => {
      const code = generateRandomString(10, "a-z", "0-9", "A-Z");
      return `${code.slice(0, 5)}-${code.slice(5)}`;
    });
    await trx.deleteFrom("auth_two_factors").where("user_id", "=", userId).execute();
    await trx
      .insertInto("auth_two_factors")
      .values({
        user_id: userId,
        secret: await symmetricEncrypt({ key: (await context).secretConfig, data: secret }),
        backup_codes: JSON.stringify(backupCodes.map((code) => hashBackupCode(config.encryptionKey, code))),
        verified: false,
      })
      .execute();
    const key = base32(Buffer.from(secret, "utf8"));
    const params = new URLSearchParams({ secret: key, issuer: APP_NAME, digits: "6", period: "30" });
    const totpUri = `otpauth://totp/${encodeURIComponent(APP_NAME)}:${encodeURIComponent(email)}?${params.toString()}`;
    return { totpUri, secret: key, backupCodes };
  }

  /** A password-only session (2FA not enrolled yet: reaches the enrolment screens and nothing else), as the library would set it. */
  async function openSession(reply: Reply, userId: string): Promise<boolean> {
    const c = await context;
    const created = await c.internalAdapter.createSession(userId, false);
    if (!created) return false;
    const signed = encodeURIComponent(`${created.token}.${await makeSignature(created.token, c.secret)}`);
    reply.addCookies([`${c.authCookies.sessionToken.name}=${signed}; Max-Age=${c.sessionConfig.expiresIn}; Path=/; HttpOnly; Secure; SameSite=Lax`]);
    return true;
  }

  // ---- endpoints ----

  async function signIn(request: Request, body: unknown): Promise<Response> {
    const reply = new Reply();
    const input = credentials.safeParse(body);
    if (!input.success) return reply.error(400, "invalid_request");
    const email = normaliseEmail(input.data.email);
    const prefix = clientIpPrefix(request.headers, config.trustedIpHeader);
    const account = accountKey(config.encryptionKey, email);
    const ip = ipKey(prefix);

    const limit = await checkSignInLimit(db, account, ip);
    if (limit.limited) {
      return reply.error(429, "rate_limited", { message: retryMessage(limit.retryAfterSeconds), retryAfterSeconds: limit.retryAfterSeconds }, { "retry-after": String(limit.retryAfterSeconds) });
    }

    const res = await auth.api.signInEmail({ body: { email, password: input.data.password }, headers: request.headers, asResponse: true });
    if (!res.ok) {
      await recordSignInFailure(db, account, ip);
      const known = await db.selectFrom("auth_users").select("id").where("email", "=", email).executeTakeFirst();
      await auditAuthEvent(db, log, "sign_in_failed", known?.id ?? null, prefix);
      return reply.error(401, "invalid_credentials");
    }
    const result = (await res.json()) as { twoFactorRedirect?: boolean };
    if (result.twoFactorRedirect) return reply.addCookies(res).json(200, { next: "code" });

    // Right password, 2FA not enrolled: setup was never finished. The password alone gets no session
    // and no authenticator secret (lead decision 5); the setup link resumes it.
    const token = await sessionTokenFrom(res);
    if (token) await db.deleteFrom("auth_sessions").where("token", "=", token).execute();
    return reply.error(403, "setup_unfinished");
  }

  async function verifyCode(request: Request, body: unknown, kind: "totp" | "backup"): Promise<Response> {
    const reply = new Reply();
    const input = codeBody.safeParse(body);
    if (!input.success) return reply.error(400, "invalid_request");
    const prefix = clientIpPrefix(request.headers, config.trustedIpHeader);
    const c = await challenge(request.headers);
    if (!c) return reply.addCookies([await twoFactorCookieCleared()]).error(401, "sign_in_again");

    const code = input.data.code.trim();
    const totp = code.replace(/\s+/g, "");
    // A replayed code is counted like any wrong code: the library is handed a value that can never match.
    const marker = kind === "totp" ? totpMarker(c.userId, totp) : null;
    const replayed = marker !== null && !(await claimTotp(marker));
    const res =
      kind === "totp"
        ? await auth.api.verifyTOTP({ body: { code: replayed ? "replayed" : totp }, headers: request.headers, asResponse: true })
        : await auth.api.verifyBackupCode({ body: { code: hashBackupCode(config.encryptionKey, code) }, headers: request.headers, asResponse: true });
    if (marker && !replayed && !res.ok) await releaseTotp(marker);
    reply.addCookies(res);
    if (res.ok) {
      await auditAuthEvent(db, log, kind === "backup" ? "backup_code_used" : "sign_in", c.userId, prefix);
      if (kind === "totp") return reply.json(200, { next: "home" });
      await auditAuthEvent(db, log, "sign_in", c.userId, prefix);
      const row = await db.selectFrom("auth_two_factors").select("backup_codes").where("user_id", "=", c.userId).executeTakeFirst();
      const left = row ? (JSON.parse(row.backup_codes) as unknown[]).length : 0;
      return reply.json(200, { next: "home", backupCodesLeft: left });
    }
    const code_ = await libraryError(res);
    if (code_ === "ACCOUNT_TEMPORARILY_LOCKED") return lockedReply(reply, c.userId);
    if (code_ === "INVALID_CODE" || code_ === "INVALID_BACKUP_CODE") {
      await auditAuthEvent(db, log, "2fa_failed", c.userId, prefix);
      if (await endChallengeIfSpent(c)) return reply.addCookies([await twoFactorCookieCleared()]).error(401, "sign_in_again");
      return reply.error(401, kind === "totp" ? "invalid_code" : "invalid_backup_code");
    }
    // Too many attempts, expired or used challenge: start again.
    return reply.addCookies([await twoFactorCookieCleared()]).error(401, "sign_in_again");
  }

  async function setupStep(userId: string): Promise<1 | 2> {
    const started = await db.selectFrom("auth_two_factors").select("id").where("user_id", "=", userId).executeTakeFirst();
    return started ? 2 : 1;
  }

  async function setupCheck(body: unknown): Promise<Response> {
    const reply = new Reply();
    const input = tokenBody.safeParse(body);
    if (!input.success) return reply.error(400, "invalid_request");
    const userId = await peekSetupToken(db, input.data.token);
    return userId ? reply.json(200, { valid: true, step: await setupStep(userId) }) : reply.error(410, "link_invalid");
  }

  async function emailOfUser(trx: Transaction<Database>, userId: string): Promise<string> {
    return (await trx.selectFrom("auth_users").select("email").where("id", "=", userId).executeTakeFirstOrThrow()).email;
  }

  async function setupPassword(body: unknown): Promise<Response> {
    const reply = new Reply();
    const input = setupBody.safeParse(body);
    if (!input.success) return reply.error(400, "invalid_request");
    const { token, password } = input.data;
    if (!(await peekSetupToken(db, token))) return reply.error(410, "link_invalid");
    const problem = passwordProblem(password);
    if (problem) return reply.error(400, problem);

    const hash = await (await context).password.hash(password);
    const done = await db.transaction().execute(async (trx) => {
      const id = await lockSetupToken(trx, token);
      // The password step is done once, per link: after it the link only resumes step 2.
      if (!id || (await trx.selectFrom("auth_two_factors").select("id").where("user_id", "=", id).executeTakeFirst())) return null;
      await trx.deleteFrom("auth_sessions").where("user_id", "=", id).execute();
      await trx.updateTable("auth_users").set({ two_factor_enabled: false, updated_at: new Date() }).where("id", "=", id).execute();
      await trx.deleteFrom("auth_accounts").where("user_id", "=", id).where("provider_id", "=", "credential").execute();
      await trx.insertInto("auth_accounts").values({ user_id: id, account_id: id, provider_id: "credential", password: hash }).execute();
      return { id, enrolment: await createEnrolment(trx, id, await emailOfUser(trx, id)) };
    });
    if (!done) return reply.error(410, "link_invalid");
    await auditAuthEvent(db, log, "password_changed", done.id, null);
    if (!(await openSession(reply, done.id))) return reply.error(500, "internal_error");
    return reply.json(200, { enrolment: done.enrolment });
  }

  /** Step 2 again, from the link alone: a new secret and backup codes, and a fresh password-only session; the password is kept. */
  async function setupResume(body: unknown): Promise<Response> {
    const reply = new Reply();
    const input = tokenBody.safeParse(body);
    if (!input.success) return reply.error(400, "invalid_request");
    const token = input.data.token;
    if (!(await peekSetupToken(db, token))) return reply.error(410, "link_invalid");
    const done = await db.transaction().execute(async (trx) => {
      const id = await lockSetupToken(trx, token);
      if (!id) return "gone" as const;
      if (!(await trx.selectFrom("auth_two_factors").select("id").where("user_id", "=", id).executeTakeFirst())) return "step1" as const;
      await trx.deleteFrom("auth_sessions").where("user_id", "=", id).execute();
      return { id, enrolment: await createEnrolment(trx, id, await emailOfUser(trx, id)) };
    });
    if (done === "gone") return reply.error(410, "link_invalid");
    if (done === "step1") return reply.error(400, "invalid_request");
    if (!(await openSession(reply, done.id))) return reply.error(500, "internal_error");
    return reply.json(200, { enrolment: done.enrolment });
  }

  async function setupConfirm(request: Request, body: unknown): Promise<Response> {
    const reply = new Reply();
    const input = codeBody.safeParse(body);
    if (!input.success) return reply.error(400, "invalid_request");
    const state = await session(request.headers);
    if (state.status !== "two-factor-required") return reply.addCookies(state.setCookies).error(401, "unauthorized");
    const current = await auth.api.getSession({ headers: request.headers });
    if (!current) return reply.error(401, "unauthorized");
    const userId = current.user.id;
    const prefix = clientIpPrefix(request.headers, config.trustedIpHeader);

    const totp = input.data.code.replace(/\s+/g, "");
    const marker = totpMarker(userId, totp);
    const fresh = await claimTotp(marker);
    const res = fresh ? await auth.api.verifyTOTP({ body: { code: totp }, headers: request.headers, asResponse: true }) : null;
    if (!res?.ok) {
      if (fresh) await releaseTotp(marker);
      await auditAuthEvent(db, log, "2fa_failed", userId, prefix);
      return reply.error(401, "invalid_code");
    }
    reply.addCookies(res);
    // Keep only the session this step just created: no password-only session survives enrolment.
    const token = await sessionTokenFrom(res);
    await db.deleteFrom("auth_sessions").where("user_id", "=", userId).where("token", "!=", token ?? "").execute();
    await deleteSetupTokens(db, userId); // the link is used up now, not at the password step
    await auditAuthEvent(db, log, "2fa_enrolled", userId, null);
    await auditAuthEvent(db, log, "sign_in", userId, prefix);
    return reply.json(200, { next: "backup-codes" });
  }

  async function sessionTokenFrom(res: Response): Promise<string | null> {
    const name = await cookieName("session_token");
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";")[0]!;
      if (!pair.startsWith(`${name}=`)) continue;
      const value = decodeURIComponent(pair.slice(name.length + 1));
      const dot = value.lastIndexOf(".");
      return dot > 0 ? value.slice(0, dot) : null;
    }
    return null;
  }

  async function signOut(request: Request, everywhere: boolean): Promise<Response> {
    const reply = new Reply();
    const current = await auth.api.getSession({ headers: request.headers }).catch(() => null);
    if (everywhere && !current) return reply.addCookies(await clearCookies()).error(401, "unauthorized");
    if (current) {
      if (everywhere) await db.deleteFrom("auth_sessions").where("user_id", "=", current.user.id).execute();
      else await db.deleteFrom("auth_sessions").where("token", "=", current.session.token).execute();
      await auditAuthEvent(db, log, "sign_out", current.user.id, null);
    }
    return reply.addCookies(await clearCookies()).json(200, { next: "sign-in" });
  }

  const routes: Record<string, (request: Request, body: unknown) => Promise<Response>> = {
    "/api/auth/sign-in": (r, b) => signIn(r, b),
    "/api/auth/two-factor/totp": (r, b) => verifyCode(r, b, "totp"),
    "/api/auth/two-factor/backup-code": (r, b) => verifyCode(r, b, "backup"),
    "/api/auth/setup/check": (_r, b) => setupCheck(b),
    "/api/auth/setup/password": (_r, b) => setupPassword(b),
    "/api/auth/setup/resume": (_r, b) => setupResume(b),
    "/api/auth/setup/confirm": (r, b) => setupConfirm(r, b),
    "/api/auth/sign-out": (r) => signOut(r, false),
    "/api/auth/sign-out-everywhere": (r) => signOut(r, true),
  };

  async function handleRequest(request: Request): Promise<Response> {
    const reply = new Reply();
    const route = routes[new URL(request.url).pathname];
    if (!route) return reply.error(404, "not_found");
    if (request.method !== "POST") return reply.error(405, "method_not_allowed", {}, { allow: "POST" });
    // CSRF: only the app's own pages may call these (SameSite=Lax cookies are the second layer).
    if (request.headers.get("origin") !== config.appUrl) return reply.error(403, "forbidden");
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return reply.error(415, "unsupported_media_type");
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return reply.error(413, "payload_too_large");
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return reply.error(413, "payload_too_large");
    let body: unknown = {};
    if (text.trim() !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        return reply.error(400, "invalid_request");
      }
    }
    return route(request, body);
  }

  return {
    handle: async (request) => {
      try {
        return await handleRequest(request);
      } catch (error) {
        // Item e: the code and the route only, never the error's message or detail.
        const code = errorCode(error);
        log("error", "auth request failed", { route: new URL(request.url).pathname, ...(code && { code }) });
        return new Reply().error(500, "internal_error");
      }
    },
    session,
  };
}

/** RFC 4648 base32 without padding, as authenticator apps expect the key in an otpauth:// link. */
function base32(bytes: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
