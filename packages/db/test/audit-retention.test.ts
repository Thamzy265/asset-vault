import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { runAuditRetention } from "../src/index.ts";
import { migrateUp } from "../src/migrate.ts";
import type { Database } from "../src/schema.ts";
import { freshDatabase } from "./support/fresh-database.ts";

describe("runAuditRetention", () => {
  let db: Kysely<Database>;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const fresh = await freshDatabase();
    drop = fresh.drop;
    db = createDb(fresh.url);
    await migrateUp(db);
  });
  afterAll(async () => {
    await db?.destroy();
    await drop?.();
  });

  it("returns how many rows it deleted and how many ip prefixes it cleared, as numbers", async () => {
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
    await sql`insert into audit_log (action, at, ip_prefix) values
      ('sign_in', ${daysAgo(800)}, null),
      ('sign_in', ${daysAgo(100)}, '10.0.0.0/24'),
      ('sign_in', ${daysAgo(1)}, '10.0.1.0/24')`.execute(db);
    expect(await runAuditRetention(db)).toEqual({ deleted: 1, ipPrefixesCleared: 1 });
    expect(await runAuditRetention(db)).toEqual({ deleted: 0, ipPrefixesCleared: 0 });
  });
});
