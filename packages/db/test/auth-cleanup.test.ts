import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { deleteExpiredAuthRows } from "../src/index.ts";
import { migrateUp } from "../src/migrate.ts";
import type { Database } from "../src/schema.ts";
import { freshDatabase, type FreshDatabase } from "./support/fresh-database.ts";

// Design note M1.3, Privacy: sessions are kept only for their life (≤ 7 days) and deleted
// by the worker. The same job drops expired setup links, sign-in challenges and failures.
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

describe("deleteExpiredAuthRows (worker, as vault_app)", () => {
  it("deletes idle-expired and older-than-7-days sessions, expired setup links and challenges, and failures older than 15 minutes; keeps live ones", async () => {
    const user = await migrator.insertInto("users").values({ role: "member" }).returning("id").executeTakeFirstOrThrow();
    await migrator.insertInto("auth_users").values({ id: user.id, email: "c@example.org", name: "C" }).execute();
    const hour = 3_600_000;
    const at = (ms: number) => new Date(Date.now() + ms);
    await migrator
      .insertInto("auth_sessions")
      .values([
        { user_id: user.id, token: "live", expires_at: at(hour) },
        { user_id: user.id, token: "idle", expires_at: at(-1000) },
        { user_id: user.id, token: "old", expires_at: at(hour), created_at: at(-7 * 24 * hour - 1000) },
      ])
      .execute();
    await migrator
      .insertInto("auth_setup_tokens")
      .values([
        { user_id: user.id, token_hash: randomUUID(), expires_at: at(hour) },
        { user_id: user.id, token_hash: randomUUID(), expires_at: at(-1000) },
      ])
      .execute();
    await migrator
      .insertInto("auth_verifications")
      .values([
        { identifier: "live", value: "x", expires_at: at(hour) },
        { identifier: "gone", value: "x", expires_at: at(-1000) },
      ])
      .execute();
    await sql`insert into auth_sign_in_failures (account_key, ip_key, at) values ('a', 'unknown', now()), ('b', 'unknown', now() - interval '16 minutes')`.execute(migrator);

    expect(await deleteExpiredAuthRows(app)).toEqual({ sessions: 2, setupTokens: 1, verifications: 1, signInFailures: 1 });
    expect((await migrator.selectFrom("auth_sessions").select("token").execute()).map((r) => r.token)).toEqual(["live"]);
    expect(await deleteExpiredAuthRows(app)).toEqual({ sessions: 0, setupTokens: 0, verifications: 0, signInFailures: 0 });
  });
});
