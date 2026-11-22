import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ValidationError } from "../src/access.ts";
import { issueSetupToken } from "../src/auth/setup-tokens.ts";
import { createLogin, deactivateLogin, LoginConflictError } from "../src/auth/logins.ts";
import { createAuthService } from "../src/auth/service.ts";
import { createDb } from "../src/client.ts";
import { runAuditRetention } from "../src/index.ts";
import { migrateUp } from "../src/migrate.ts";
import type { Database } from "../src/schema.ts";
import { TestBrowser } from "./support/auth-client.ts";
import { freshDatabase, type FreshDatabase } from "./support/fresh-database.ts";
import { secretFromUri, totpCode } from "./support/totp.ts";

// The admin's server commands (design note M1.3): user:create and user:deactivate, run as vault_app.
const ORIGIN = "http://127.0.0.1:3000";
let fresh: FreshDatabase;
let migrator: Kysely<Database>;
let app: Kysely<Database>;
beforeAll(async () => {
  fresh = await freshDatabase();
  migrator = createDb(fresh.url);
  await migrateUp(migrator);
  app = createDb(fresh.appUrl);
});
afterAll(async () => {
  await app?.destroy();
  await migrator?.destroy();
  await fresh?.drop();
});
const email = () => `u-${randomUUID().slice(0, 8)}@example.org`;

describe("createLogin (pnpm user:create)", () => {
  it("creates a user, a person with the same name, the sign-in row and a 24 h setup link; audited as create, no values", async () => {
    const address = email();
    const created = await createLogin(app, { email: `  ${address.toUpperCase()} `, name: "  Ada Lovelace ", role: "admin" });
    expect(created.reissued).toBe(false);
    expect(created.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const user = await migrator.selectFrom("users").selectAll().where("id", "=", created.userId).executeTakeFirstOrThrow();
    expect(user).toMatchObject({ role: "admin", person_id: created.personId, deactivated_at: null });
    const login = await migrator.selectFrom("auth_users").selectAll().where("id", "=", created.userId).executeTakeFirstOrThrow();
    expect(login).toMatchObject({ email: address, name: "Ada Lovelace", two_factor_enabled: false, image: null });
    const person = await migrator.selectFrom("people").select("display_name").where("id", "=", created.personId).executeTakeFirstOrThrow();
    expect(person.display_name).toBe("Ada Lovelace");
    const audit = await migrator.selectFrom("audit_log").select(["action", "entity_type", "details"]).where("entity_id", "in", [created.userId, created.personId]).orderBy("id").execute();
    expect(audit).toEqual([
      { action: "create", entity_type: "person", details: { fields: ["display_name"] } },
      { action: "create", entity_type: "user", details: { fields: ["email", "name", "role", "person_id"] } },
    ]);
  });

  it("links an existing person instead of creating one, and refuses a person that already has a login", async () => {
    const person = await migrator.insertInto("people").values({ display_name: "Existing" }).returning("id").executeTakeFirstOrThrow();
    const created = await createLogin(app, { email: email(), name: "Existing", role: "member", personId: person.id.toUpperCase() });
    expect(created.personId).toBe(person.id);
    await expect(createLogin(app, { email: email(), name: "Twin", role: "member", personId: person.id })).rejects.toBeInstanceOf(LoginConflictError);
    await expect(createLogin(app, { email: email(), name: "Nobody", role: "member", personId: randomUUID() })).rejects.toBeInstanceOf(LoginConflictError);
  });

  it("for an email that already has a login, issues a new link (revoking the old one) and changes nothing else; a different role is refused", async () => {
    const address = email();
    const first = await createLogin(app, { email: address, name: "Bo", role: "member" });
    const second = await createLogin(app, { email: address, name: "Bo", role: "member" });
    expect(second).toMatchObject({ reissued: true, userId: first.userId, personId: first.personId });
    expect(second.setupToken).not.toBe(first.setupToken);
    expect((await migrator.selectFrom("auth_setup_tokens").select("id").where("user_id", "=", first.userId).execute()).length).toBe(1);
    await expect(createLogin(app, { email: address, name: "Bo", role: "admin" })).rejects.toBeInstanceOf(LoginConflictError);
  });

  it.each([
    [{ email: "not-an-email", name: "X", role: "member" }, ["email"]],
    [{ email: "a@example.org", name: "  ", role: "member" }, ["name"]],
    [{ email: "a@example.org", name: "X", role: "root" }, ["role"]],
    [{ email: "a@example.org", name: "X", role: "member", personId: "nope" }, ["personId"]],
  ])("refuses bad input %j, naming the field and never the value", async (input, fields) => {
    const error = await createLogin(app, input as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fields).toEqual(fields);
  });
});

describe("deactivateLogin (pnpm user:deactivate)", () => {
  async function enrolled() {
    const address = email();
    const created = await createLogin(app, { email: address, name: "Leaver", role: "member" });
    const auth = createAuthService(app, { appUrl: ORIGIN, encryptionKey: "k".repeat(40), trustedIpHeader: null });
    const b = new TestBrowser((r) => auth.handle(r), ORIGIN);
    const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password: "correct horse battery" });
    const secret = secretFromUri((setup.body.enrolment as { totpUri: string }).totpUri);
    await b.post("/api/auth/setup/confirm", { code: totpCode(secret) });
    expect((await auth.session(b.headers())).status).toBe("signed-in");
    // An outstanding setup link too. (A re-issue through createLogin would end the session first, so the row is added directly.)
    await migrator.transaction().execute((trx) => issueSetupToken(trx, created.userId));
    return { address, created, auth, b };
  }

  it("deletes the password hash, TOTP secret, backup codes, sessions, setup links, email and name; clears person_id; sets deactivated_at", async () => {
    const { address, created, auth, b } = await enrolled();
    expect(await deactivateLogin(app, address.toUpperCase())).toBe(true);
    for (const table of ["auth_users", "auth_accounts", "auth_two_factors", "auth_sessions", "auth_setup_tokens"] as const) {
      const column = table === "auth_users" ? "id" : "user_id";
      const { rows } = await sql`select 1 from ${sql.table(table)} where ${sql.ref(column)} = ${created.userId}`.execute(migrator);
      expect(rows, table).toEqual([]);
    }
    const user = await migrator.selectFrom("users").selectAll().where("id", "=", created.userId).executeTakeFirstOrThrow();
    expect(user.person_id).toBeNull();
    expect(user.deactivated_at).toBeInstanceOf(Date);
    expect(JSON.stringify(await migrator.selectFrom("users").selectAll().where("id", "=", created.userId).execute())).not.toContain(address);
    // Refused on the next request, and can't sign in again.
    expect((await auth.session(b.headers())).status).toBe("signed-out");
    const again = await new TestBrowser((r) => auth.handle(r), ORIGIN).post("/api/auth/sign-in", { email: address, password: "correct horse battery" });
    expect(again.status).toBe(401);
    // The person stays; audited as an update of the user, field names only.
    expect(await migrator.selectFrom("people").select("id").where("id", "=", created.personId).executeTakeFirst()).toBeDefined();
    const audit = await migrator.selectFrom("audit_log").select(["action", "details"]).where("entity_id", "=", created.userId).where("action", "=", "update").execute();
    expect(audit).toEqual([{ action: "update", details: { fields: ["email", "name", "person_id", "deactivated_at"] } }]);
  });

  it("item c: the linked person can be deleted afterwards (no login link blocks the erasure)", async () => {
    const { address, created } = await enrolled();
    await deactivateLogin(app, address);
    await expect(sql`delete from people where id = ${created.personId}`.execute(migrator)).resolves.toBeDefined();
  });

  it("an unknown or already deactivated email returns false and changes nothing", async () => {
    expect(await deactivateLogin(app, email())).toBe(false);
    const { address } = await enrolled();
    expect(await deactivateLogin(app, address)).toBe(true);
    expect(await deactivateLogin(app, address)).toBe(false);
  });

  it("the email can be given a new login later; the old user row stays while the audit log names it", async () => {
    const { address, created } = await enrolled();
    await deactivateLogin(app, address);
    const returning = await createLogin(app, { email: address, name: "Returning", role: "member" });
    expect(returning.userId).not.toBe(created.userId);
    await runAuditRetention(app);
    expect(await migrator.selectFrom("users").select("id").where("id", "=", created.userId).executeTakeFirst()).toBeDefined();
  });
});
