import { sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "../access.ts";
import { kyselyOf, type DbLike } from "../handle.ts";
import { normaliseDisplayName } from "../names.ts";
import type { Role } from "../schema.ts";
import { normaliseEmail } from "./rate-limit.ts";
import { issueSetupToken } from "./setup-tokens.ts";

/**
 * Server commands for the admin (design note M1.3: no public sign-up). Run by
 * `pnpm user:create` and `pnpm user:deactivate` (users-cli.ts), as vault_app.
 */
export type NewLogin = { email: string; name: string; role: Role; personId?: string | null };
export type CreatedLogin = {
  userId: string;
  personId: string;
  setupToken: string;
  expiresAt: Date;
  /** True when the email already had an active login: only a new setup link was issued. */
  reissued: boolean;
};

export class LoginConflictError extends Error {
  override name = "LoginConflictError";
}

const emailSchema = z.email().max(254);

/**
 * Creates a login (and, unless personId names an existing person, a person
 * with the same name) and issues a setup link valid for 24 h. For an email
 * that already has an active login it only issues a new link, revoking the
 * old one; using it resets the password, 2FA and sessions (lost phone).
 * Audited as create (user, person) with no actor: the server admin.
 */
export async function createLogin(handle: DbLike, input: NewLogin): Promise<CreatedLogin> {
  const db = kyselyOf(handle);
  const email = normaliseEmail(input.email);
  const name = normaliseDisplayName(input.name);
  const bad: string[] = [];
  if (!emailSchema.safeParse(email).success) bad.push("email");
  if (name === null) bad.push("name");
  if (input.role !== "admin" && input.role !== "member") bad.push("role");
  if (input.personId != null && !z.uuid().safeParse(input.personId).success) bad.push("personId");
  if (bad.length) throw new ValidationError(bad);

  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom("auth_users")
      .innerJoin("users", "users.id", "auth_users.id")
      .select(["users.id", "users.role", "users.person_id"])
      .where("auth_users.email", "=", email)
      .forUpdate()
      .executeTakeFirst();
    if (existing) {
      if (existing.role !== input.role) throw new LoginConflictError("This email already has a login with another role; nothing was changed.");
      const link = await issueSetupToken(trx, existing.id);
      return { userId: existing.id, personId: existing.person_id!, setupToken: link.token, expiresAt: link.expiresAt, reissued: true };
    }

    let personId = input.personId?.toLowerCase() ?? null;
    if (personId) {
      const person = await trx.selectFrom("people").select("id").where("id", "=", personId).executeTakeFirst();
      if (!person) throw new LoginConflictError("No person with that id.");
      const linked = await trx.selectFrom("users").select("id").where("person_id", "=", personId).executeTakeFirst();
      if (linked) throw new LoginConflictError("That person already has a login.");
    } else {
      personId = (await trx.insertInto("people").values({ display_name: name! }).returning("id").executeTakeFirstOrThrow()).id;
      await trx.insertInto("audit_log").values({ action: "create", entity_type: "person", entity_id: personId, details: JSON.stringify({ fields: ["display_name"] }) }).execute();
    }
    const user = await trx.insertInto("users").values({ role: input.role, person_id: personId }).returning("id").executeTakeFirstOrThrow();
    await trx.insertInto("auth_users").values({ id: user.id, email, name: name! }).execute();
    await trx
      .insertInto("audit_log")
      .values({ action: "create", entity_type: "user", entity_id: user.id, details: JSON.stringify({ fields: ["email", "name", "role", "person_id"] }) })
      .execute();
    const link = await issueSetupToken(trx, user.id);
    return { userId: user.id, personId, setupToken: link.token, expiresAt: link.expiresAt, reissued: false };
  });
}

/**
 * Deactivates a login (design note M1.3, Privacy): deletes its sign-in data
 * (auth_users: email and name; and by cascade the password hash, TOTP secret,
 * backup codes, sessions and setup links), clears person_id (item c, so an
 * erasure request for the person isn't blocked) and sets deactivated_at. The
 * users row (id, role) stays for the audit log until retention removes it.
 * Returns false if no active login has that email.
 */
export async function deactivateLogin(handle: DbLike, rawEmail: string): Promise<boolean> {
  const db = kyselyOf(handle);
  const email = normaliseEmail(rawEmail);
  return db.transaction().execute(async (trx) => {
    const found = await trx.selectFrom("auth_users").select("id").where("email", "=", email).forUpdate().executeTakeFirst();
    if (!found) return false;
    await trx.deleteFrom("auth_users").where("id", "=", found.id).execute();
    await trx.updateTable("users").set({ deactivated_at: sql<Date>`now()`, person_id: null }).where("id", "=", found.id).execute();
    await trx
      .insertInto("audit_log")
      .values({ action: "update", entity_type: "user", entity_id: found.id, details: JSON.stringify({ fields: ["email", "name", "person_id", "deactivated_at"] }) })
      .execute();
    return true;
  });
}
