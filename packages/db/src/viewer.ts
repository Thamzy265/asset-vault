import { z } from "zod";
import type { Role } from "./schema.ts";

declare const brand: unique symbol;

/**
 * Who is asking. Every repository function takes one (M1.2 decision 7): the
 * repositories trust it, so it must come from a verified session with 2FA
 * passed. Only the session module (auth/session.ts) creates one, with
 * mintViewer, which is internal to packages/db (M1.3 item a):
 * - at compile time the brand makes a hand-made object unassignable;
 * - at run time checkViewer (access.ts) refuses any object mintViewer didn't
 *   create, so a cast, a copy or a parsed JSON object is not a viewer.
 */
export type Viewer = {
  readonly userId: string;
  readonly role: Role;
  /** The person this login is linked to, if any. */
  readonly personId: string | null;
  readonly [brand]: true;
};

const fields = z.strictObject({
  userId: z.uuid(),
  role: z.enum(["admin", "member"]),
  personId: z.uuid().nullable(),
});

/** Viewers mintViewer created. A WeakSet: holds no viewer alive. */
const minted = new WeakSet<object>();

/**
 * Internal to packages/db (never exported from index.ts): only
 * auth/session.ts, and packages/db's own tests, call it. Keeps the three
 * fields only, refuses malformed ones, and freezes the result.
 */
export function mintViewer(input: { userId: string; role: Role; personId: string | null }): Viewer {
  const result = fields.safeParse({ userId: input.userId, role: input.role, personId: input.personId });
  if (!result.success) throw new TypeError("Invalid viewer");
  const viewer = Object.freeze({ ...result.data });
  minted.add(viewer);
  return viewer as unknown as Viewer;
}

/** True only for an object mintViewer returned. */
export function isMintedViewer(value: unknown): value is Viewer {
  return typeof value === "object" && value !== null && minted.has(value);
}
