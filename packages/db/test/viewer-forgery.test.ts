import { randomUUID } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogin } from "../src/auth/logins.ts";
import { createAuthService, type AuthService } from "../src/auth/service.ts";
import { createDb } from "../src/client.ts";
import * as publicApi from "../src/index.ts";
import { migrateUp } from "../src/migrate.ts";
import { peopleRepository } from "../src/people.ts";
import type { Database } from "../src/schema.ts";
import type { Viewer } from "../src/viewer.ts";
import { TestBrowser } from "./support/auth-client.ts";
import { freshDatabase, type FreshDatabase } from "./support/fresh-database.ts";
import { secretFromUri, totpCode } from "./support/totp.ts";

// Independent tester round for M1.3 item (a): "can app code build an admin viewer by any route?"
// The developer's viewer.test.ts covers a hand-made object, a spread, structuredClone and a JSON
// round trip. These go through the other routes: prototypes, proxies, accessors, serialisation,
// and the one real way to get a viewer (a session), checking what the repositories accept.
const KEY = "tester-viewer-key-".padEnd(48, "v");
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery";

let fresh: FreshDatabase;
let db: Kysely<Database>;
let app: Kysely<Database>;
let auth: AuthService;
let member: Viewer;
let memberUserId: string;
let adminPersonId: string;

beforeAll(async () => {
  fresh = await freshDatabase();
  db = createDb(fresh.url);
  await migrateUp(db);
  app = createDb(fresh.appUrl);
  auth = createAuthService(app, { appUrl: ORIGIN, encryptionKey: KEY, trustedIpHeader: null }, { log: () => {} });
  const created = await createLogin(app, { email: `viewer-${randomUUID().slice(0, 8)}@example.org`, name: "Member", role: "member" });
  memberUserId = created.userId;
  adminPersonId = (await db.insertInto("people").values({ display_name: "Someone" }).returning("id").executeTakeFirstOrThrow()).id;
  const b = new TestBrowser((r) => auth.handle(r), ORIGIN);
  const setup = await b.post("/api/auth/setup/password", { token: created.setupToken, password: PASSWORD });
  await b.post("/api/auth/setup/confirm", { code: totpCode(secretFromUri((setup.body.enrolment as { totpUri: string }).totpUri)) });
  const state = await auth.session(b.headers());
  if (state.status !== "signed-in") throw new Error("expected a signed-in member");
  member = state.viewer; // the one real route: a verified session
});
afterAll(async () => {
  await app?.destroy();
  await db?.destroy();
  await fresh?.drop();
});

const people = () => peopleRepository(app, { log: () => {} });

describe("no route but the session check yields something the repositories accept as a viewer", () => {
  it("the viewer a session gives is accepted, is a member, and is frozen", async () => {
    await expect(people().list(member)).resolves.toEqual(expect.any(Array));
    expect(member.role).toBe("member");
    expect(member.userId).toBe(memberUserId);
    expect(Object.isFrozen(member)).toBe(true);
  });

  it("an object that inherits from a real viewer, or has its prototype, is refused", async () => {
    const heir = Object.create(member, { role: { value: "admin" } }) as Viewer;
    const sameProto = Object.assign(Object.create(Object.getPrototypeOf(member)) as object, { userId: member.userId, role: "admin", personId: null }) as Viewer;
    const reparented = Object.setPrototypeOf({ userId: member.userId, role: "admin", personId: null }, member) as Viewer;
    for (const forged of [heir, sameProto, reparented]) await expect(people().list(forged)).rejects.toThrow(/viewer/i);
  });

  it("a Proxy around a real viewer, with or without traps, is refused (so a viewer can't be wrapped to say 'admin')", async () => {
    const plain = new Proxy(member, {}) as Viewer;
    const lying = new Proxy(member, { get: (target, key) => (key === "role" ? "admin" : Reflect.get(target, key)) }) as Viewer;
    for (const forged of [plain, lying]) await expect(people().list(forged)).rejects.toThrow(/viewer/i);
  });

  it("getters, class instances, null-prototype objects and frozen copies with the right fields are refused", async () => {
    const withGetters = { get userId() { return member.userId; }, get role() { return "admin"; }, get personId() { return null; } } as unknown as Viewer;
    class Fake { userId = member.userId; role = "admin"; personId = null; }
    const nullProto = Object.assign(Object.create(null) as object, { userId: member.userId, role: "admin", personId: null }) as Viewer;
    const frozen = Object.freeze({ userId: member.userId, role: "admin", personId: null }) as unknown as Viewer;
    const withBrandLooking = { ...member, role: "admin", [Symbol("brand")]: true } as unknown as Viewer;
    for (const forged of [withGetters, new Fake() as unknown as Viewer, nullProto, frozen, withBrandLooking]) await expect(people().list(forged)).rejects.toThrow(/viewer/i);
  });

  it("serialisation round trips lose the registration: v8 serialize/deserialize, JSON, structuredClone, Object.fromEntries(Object.entries())", async () => {
    const copies = [deserialize(serialize(member)), JSON.parse(JSON.stringify(member)), structuredClone(member), Object.fromEntries(Object.entries(member)), Object.create(null, Object.getOwnPropertyDescriptors(member))] as Viewer[];
    for (const copy of copies) await expect(people().list(copy)).rejects.toThrow(/viewer/i);
  });

  it("junk is refused too, never treated as 'no restrictions': undefined, null, strings, numbers, arrays, functions", async () => {
    for (const junk of [undefined, null, "admin", 1, [], () => ({}), true, Symbol("x")]) await expect(people().list(junk as unknown as Viewer)).rejects.toThrow();
  });

  it("a real member viewer can't be turned into an admin afterwards: assignment, redefinition and deletion all fail", () => {
    "use strict";
    expect(() => Object.assign(member, { role: "admin" })).toThrow();
    expect(() => Object.defineProperty(member, "role", { value: "admin" })).toThrow();
    expect(() => Reflect.deleteProperty(member, "role") || (() => { throw new Error("not deleted"); })()).toThrow();
    expect(() => Object.setPrototypeOf(member, {})).toThrow();
    expect(member.role).toBe("member");
  });

  it("a real member viewer can't delete a person it doesn't manage (the role it carries is the database's, not a claim)", async () => {
    await expect(people().remove(member, adminPersonId)).rejects.toThrow();
    expect(await db.selectFrom("people").select("id").where("id", "=", adminPersonId).executeTakeFirst()).toBeDefined();
  });

  it("the package's public API exports no way to mint a viewer or to reach the raw client", () => {
    const names = Object.keys(publicApi);
    for (const forbidden of ["mintViewer", "isMintedViewer", "checkViewer", "createDb", "kyselyOf", "authOptions", "resolveSession", "createLogin", "deactivateLogin", "hashBackupCode", "issueSetupToken"]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });
});
