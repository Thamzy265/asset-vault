import { createHmac } from "node:crypto";
import type { BetterAuthOptions } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import type { Kysely } from "kysely";
import { log as defaultLog } from "../log.ts";
import type { Database } from "../schema.ts";
import type { AuthConfig } from "./config.ts";

/** Better Auth's models -> our tables (migration 0007_auth mirrors this; test/auth-schema.test.ts checks it). */
export const AUTH_TABLES = {
  user: "auth_users",
  session: "auth_sessions",
  account: "auth_accounts",
  verification: "auth_verifications",
  twoFactor: "auth_two_factors",
} as const;

/** Session lifetime (design note M1.3): 24 h idle, 7 days absolute (the absolute limit is checked in session.ts). */
export const SESSION_IDLE_SECONDS = 24 * 60 * 60;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
/** How often an active session's idle expiry is pushed forward (one write per 5 minutes of use, not per request). */
const SESSION_REFRESH_SECONDS = 5 * 60;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const BACKUP_CODE_COUNT = 10;
export const APP_NAME = "Family Asset Vault";

const HASHED = "hmac:";

/**
 * Keyed hash of a backup code (design note M1.3: backup codes stored hashed).
 * HMAC with AUTH_ENCRYPTION_KEY, so a copy of the database alone can't be
 * brute-forced offline.
 */
export function hashBackupCode(key: string, code: string): string {
  return HASHED + createHmac("sha256", key).update(`backup-code:${code}`).digest("base64url");
}

/**
 * Better Auth's two-factor plugin stores backup codes through this pair. It
 * calls `encrypt` with a JSON list of codes when it generates them (plain
 * codes) and after one is used (the remaining, already hashed, entries), and
 * compares the code it is given with the list `decrypt` returns. So we store
 * hashes, and auth.ts hashes the code a person types before handing it over.
 */
function backupCodeStore(key: string) {
  return {
    encrypt: async (json: string) => {
      const codes = JSON.parse(json) as string[];
      return JSON.stringify(codes.map((code) => (code.startsWith(HASHED) ? code : hashBackupCode(key, code))));
    },
    decrypt: async (stored: string) => stored,
  };
}

export type AuthHooks = {
  /** Runs before Better Auth creates a session; false refuses it (deactivated users, item b). */
  beforeSessionCreate?: (userId: string) => Promise<boolean>;
};

/**
 * The Better Auth configuration (pinned version, see package.json). Only
 * packages/db builds it: it holds the raw database client.
 */
export function authOptions(db: Kysely<Database>, config: AuthConfig, hooks: AuthHooks = {}) {
  return {
    appName: APP_NAME,
    baseURL: config.appUrl,
    basePath: "/api/auth",
    secret: config.encryptionKey,
    database: { db, type: "postgres", transaction: true },
    telemetry: { enabled: false },
    // Our own limits (rate-limit.ts) replace the library's in-memory, per-IP one.
    rateLimit: { enabled: false },
    // Library errors carry no request data in the message, but their extra arguments can
    // (row values, emails), so only the message is logged (item e).
    logger: {
      level: "error",
      log: (level, message) => defaultLog(level === "error" ? "error" : "warn", "auth library", { detail: String(message).slice(0, 200) }),
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    },
    user: {
      modelName: AUTH_TABLES.user,
      fields: { emailVerified: "email_verified", createdAt: "created_at", updatedAt: "updated_at" },
    },
    session: {
      modelName: AUTH_TABLES.session,
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "user_id",
      },
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
    },
    account: {
      modelName: AUTH_TABLES.account,
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: AUTH_TABLES.verification,
      fields: { expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at" },
    },
    advanced: {
      database: { generateId: "uuid" },
      cookiePrefix: "vault",
      // HttpOnly, Secure, SameSite=Lax on every auth cookie (design note M1.3).
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
      // No full IP addresses are stored (minimisation); the client IP is read only from
      // the configured trusted header, in ip.ts, and kept as a prefix in the audit log.
      ipAddress: { disableIpTracking: true },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session: { userId: string }) => {
            if (hooks.beforeSessionCreate && !(await hooks.beforeSessionCreate(session.userId))) return false;
            return undefined;
          },
        },
      },
    },
    plugins: [
      twoFactor({
        issuer: APP_NAME,
        backupCodeOptions: { amount: BACKUP_CODE_COUNT, storeBackupCodes: backupCodeStore(config.encryptionKey) },
        // A sign-in challenge (the two_factor cookie) lasts 10 minutes.
        twoFactorCookieMaxAge: 600,
        schema: {
          user: { fields: { twoFactorEnabled: "two_factor_enabled" } },
          twoFactor: {
            modelName: AUTH_TABLES.twoFactor,
            fields: {
              backupCodes: "backup_codes",
              userId: "user_id",
              failedVerificationCount: "failed_verification_count",
              lockedUntil: "locked_until",
            },
          },
        },
      }),
    ],
  } satisfies BetterAuthOptions;
}
