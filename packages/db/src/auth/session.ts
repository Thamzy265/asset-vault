import type { Kysely } from "kysely";
import type { Database, Role } from "../schema.ts";
import { mintViewer, type Viewer } from "../viewer.ts";
import { SESSION_ABSOLUTE_MS } from "./options.ts";

/**
 * THE session check (design note M1.3; M1.2 decision 7; items a and b). The
 * only code that creates a Viewer: from a live session whose user is active
 * and has 2FA enrolled, which (see service.ts) means 2FA was passed for this
 * session. Every request that reads data goes through here.
 */
export type SessionUser = { id: string; name: string; role: Role; personId: string | null };

export type SessionState =
  | { status: "signed-in"; viewer: Viewer; user: SessionUser; setCookies: string[] }
  /** A session with the password only: 2FA isn't enrolled yet. Reaches the enrolment screens, nothing else (403). */
  | { status: "two-factor-required"; setCookies: string[] }
  /** No session (401). "ended": there was a session cookie, but the session expired, was revoked or the user was deactivated. */
  | { status: "signed-out"; reason: "none" | "ended"; setCookies: string[] };

export type LibrarySession = { session: { token: string; userId: string; createdAt: Date } } | null;

export type SessionDeps = {
  db: Kysely<Database>;
  /** Better Auth's getSession: the session for the cookie (idle expiry checked), and any Set-Cookie it wants sent. */
  getLibrarySession: (headers: Headers) => Promise<{ session: LibrarySession; setCookies: string[] }>;
  /** Set-Cookie values that clear the session cookies. */
  clearCookies: () => string[];
  sessionCookieName: string;
  now?: () => number;
};

export async function resolveSession(deps: SessionDeps, headers: Headers): Promise<SessionState> {
  const hadCookie = cookieNames(headers).includes(deps.sessionCookieName);
  const ended = (setCookies: string[]): SessionState => ({ status: "signed-out", reason: hadCookie ? "ended" : "none", setCookies });

  const { session, setCookies } = await deps.getLibrarySession(headers);
  if (!session) return ended(setCookies);

  const row = await deps.db
    .selectFrom("users")
    .innerJoin("auth_users", "auth_users.id", "users.id")
    .leftJoin("auth_two_factors", "auth_two_factors.user_id", "auth_users.id")
    .select(["users.id", "users.role", "users.person_id", "users.deactivated_at", "auth_users.name", "auth_users.two_factor_enabled", "auth_two_factors.verified as two_factor_verified"])
    .where("users.id", "=", session.session.userId)
    .executeTakeFirst();

  // Item b: a deactivated user is refused on every request, and loses every session.
  if (!row || row.deactivated_at !== null) {
    await deps.db.deleteFrom("auth_sessions").where("user_id", "=", session.session.userId).execute();
    return ended(deps.clearCookies());
  }
  // 7 days absolute, however active the session (idle expiry is the library's).
  const now = deps.now?.() ?? Date.now();
  if (new Date(session.session.createdAt).getTime() + SESSION_ABSOLUTE_MS <= now) {
    await deps.db.deleteFrom("auth_sessions").where("token", "=", session.session.token).execute();
    return ended(deps.clearCookies());
  }
  // 2FA counts as passed only with the flag on AND a verified enrolment (reviewer S2a): never on the flag alone.
  if (!row.two_factor_enabled || row.two_factor_verified !== true) return { status: "two-factor-required", setCookies };

  const viewer = mintViewer({ userId: row.id, role: row.role, personId: row.person_id });
  return { status: "signed-in", viewer, user: { id: row.id, name: row.name, role: row.role, personId: row.person_id }, setCookies };
}

export function cookieNames(headers: Headers): string[] {
  return (headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.split("=")[0]!.trim())
    .filter(Boolean);
}

export function cookieValue(headers: Headers, name: string): string | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
