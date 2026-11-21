import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import * as publicApi from "../src/index.ts";
import { migrateUp } from "../src/migrate.ts";
import { peopleRepository } from "../src/people.ts";
import type { Database } from "../src/schema.ts";
import { mintViewer, type Viewer } from "../src/viewer.ts";
import { freshDatabase, type FreshDatabase } from "./support/fresh-database.ts";

// M1.3 carried item (a), M1.2 decision 7: the repositories trust the Viewer they are given,
// so only the session module may create one (from a verified session with 2FA passed).
// A Viewer is a branded type at compile time and a registered, frozen object at run time:
// an object that merely has the right fields is refused.
let fresh: FreshDatabase;
let db: Kysely<Database>;
let admin: Viewer;
let personId: string;
beforeAll(async () => {
  fresh = await freshDatabase();
  db = createDb(fresh.url);
  await migrateUp(db);
  personId = (await db.insertInto("people").values({ display_name: "Admin" }).returning("id").executeTakeFirstOrThrow()).id;
  const user = await db.insertInto("users").values({ role: "admin", person_id: personId }).returning("id").executeTakeFirstOrThrow();
  admin = mintViewer({ userId: user.id, role: "admin", personId });
});
afterAll(async () => {
  await db?.destroy();
  await fresh?.drop();
});

describe("Viewer is created only by mintViewer (item a)", () => {
  it("a minted viewer works with the repositories", async () => {
    const people = peopleRepository(db, { log: () => {} });
    await expect(people.list(admin)).resolves.toEqual(expect.any(Array));
  });

  it("an object with exactly the right fields, but not minted, is refused by every repository function", async () => {
    const people = peopleRepository(db, { log: () => {} });
    const forged = { userId: admin.userId, role: "admin", personId } as unknown as Viewer;
    await expect(people.list(forged)).rejects.toThrow(/viewer/i);
    await expect(people.get(forged, personId)).rejects.toThrow(/viewer/i);
    await expect(people.create(forged, { displayName: "X" })).rejects.toThrow(/viewer/i);
    await expect(people.update(forged, personId, { relationship: "x" })).rejects.toThrow(/viewer/i);
    await expect(people.remove(forged, personId)).rejects.toThrow(/viewer/i);
  });

  it("a copy of a minted viewer (spread, structuredClone, JSON round trip) is not a viewer", async () => {
    const people = peopleRepository(db, { log: () => {} });
    for (const copy of [{ ...admin }, structuredClone(admin), JSON.parse(JSON.stringify(admin))] as Viewer[]) {
      await expect(people.list(copy)).rejects.toThrow(/viewer/i);
    }
  });

  it("a minted viewer is frozen: its role can't be changed afterwards", () => {
    const member = mintViewer({ userId: randomUUID(), role: "member", personId: null });
    expect(Object.isFrozen(member)).toBe(true);
    expect(() => {
      (member as { role: string }).role = "admin";
    }).toThrow(TypeError);
    expect(member.role).toBe("member");
  });

  it("mintViewer keeps only the three fields and refuses a malformed one", () => {
    const v = mintViewer({ userId: admin.userId, role: "member", personId: null, isAdmin: true } as never);
    expect(Object.keys(v).sort()).toEqual(["personId", "role", "userId"]);
    expect(() => mintViewer({ userId: "x", role: "member", personId: null })).toThrow(TypeError);
    expect(() => mintViewer({ userId: randomUUID(), role: "root" as never, personId: null })).toThrow(TypeError);
  });

  it("the public API exports the Viewer type only, never mintViewer", () => {
    expect(Object.keys(publicApi)).not.toContain("mintViewer");
  });

  it("inside packages/db/src, only the session module imports mintViewer", () => {
    const src = path.join(import.meta.dirname, "../src");
    const importers = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && f !== "viewer.ts")
      .filter((f) => /import\s*\{[^}]*\bmintViewer\b[^}]*\}\s*from/.test(readFileSync(path.join(src, f), "utf8")));
    for (const f of importers) expect(["auth/session.ts"], f).toContain(f);
  });
});
