import { z } from "zod";
import { ConfigError } from "../config.ts";

/** Sign-in settings from the environment (design note M1.3). */
export type AuthConfig = {
  /** The origin people open the app at, e.g. https://vault.example.org. Cookies, CSRF checks and setup links use it. */
  appUrl: string;
  /**
   * AUTH_ENCRYPTION_KEY: encrypts TOTP secrets at rest, keys the backup-code and
   * rate-limit hashes, and signs the auth cookies (it is Better Auth's `secret`).
   */
  encryptionKey: string;
  /**
   * The one request header that carries the client IP, set by a proxy in front of
   * the app that overwrites any client value (e.g. cf-connecting-ip behind
   * Cloudflare). Null (the default): the client IP is unknown, no ip_prefix is
   * recorded and every client shares one rate-limit bucket.
   */
  trustedIpHeader: string | null;
};

/** Headers a client can append to or forge hop by hop: never trusted for the client IP. */
const UNTRUSTWORTHY_IP_HEADERS = new Set(["x-forwarded-for", "forwarded", "x-real-ip"]);
const MIN_KEY_LENGTH = 32;

const schema = z.object({
  APP_URL: z
    .string({ error: "is required" })
    .min(1, { error: "is required" })
    .superRefine((value, ctx) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "must be an http(s) URL" });
        return;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") ctx.addIssue({ code: "custom", message: "must be an http(s) URL" });
      else if (url.origin !== value.replace(/\/$/, "")) ctx.addIssue({ code: "custom", message: "must be an origin only (scheme, host and port; no path, query or credentials)" });
    })
    .transform((value) => new URL(value).origin),
  AUTH_ENCRYPTION_KEY: z
    .string({ error: "is required" })
    .min(1, { error: "is required" })
    .min(MIN_KEY_LENGTH, { error: `must be at least ${MIN_KEY_LENGTH} characters (openssl rand -hex 32)` })
    .regex(/^\S+$/, { error: "must not contain spaces" }),
  AUTH_TRUSTED_IP_HEADER: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === "" ? null : value.trim().toLowerCase()))
    .refine((value) => value === null || /^[a-z0-9-]{1,64}$/.test(value), { error: "must be a header name" })
    .refine((value) => value === null || !UNTRUSTWORTHY_IP_HEADERS.has(value), {
      error: "must be a header your proxy sets and overwrites (e.g. cf-connecting-ip); X-Forwarded-For, Forwarded and X-Real-IP are never trusted",
    }),
});

/**
 * Validates the sign-in settings at start. Messages name the variable and the
 * rule, never the value (the key is a secret).
 */
export function loadAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`);
    throw new ConfigError(`Invalid configuration: ${problems.join("; ")}`);
  }
  return {
    appUrl: result.data.APP_URL,
    encryptionKey: result.data.AUTH_ENCRYPTION_KEY,
    trustedIpHeader: result.data.AUTH_TRUSTED_IP_HEADER,
  };
}
