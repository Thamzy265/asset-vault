import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { migrateUp } from "../src/migrate.ts";
import type { Database } from "../src/schema.ts";
import { freshDatabase, type FreshDatabase } from "./support/fresh-database.ts";

// pnpm user:create / user:deactivate (design note M1.3): the admin's server commands.
// They run in the worker image as vault_app (the role the worker uses), with APP_URL for the link.
const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/users-cli.ts", import.meta.url));
const APP_URL = "https://vault.example.org";

let fresh: FreshDatabase;
let migrator: Kysely<Database>;
beforeAll(async () => {
  fresh = await freshDatabase();
  migrator = createDb(fresh.url);
  await migrateUp(migrator);
});
afterAll(async () => {
  await migrator?.destroy();
  await fresh?.drop();
});

async function users(args: string[], env: Record<string, string> = { DATABASE_URL: fresh.appUrl, APP_URL }) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("users CLI", () => {
  it("create prints a one-time setup link (token in the fragment, so it never reaches a server log) and when it expires", async () => {
    const result = await users(["create", "--email", "ada@example.org", "--name", "Ada Lovelace", "--role", "admin"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`${APP_URL}/setup#[A-Za-z0-9_-]{43}\\n`));
    expect(result.stdout).toMatch(/valid for 24 hours/i);
    const user = await migrator.selectFrom("auth_users").select(["email", "name"]).where("email", "=", "ada@example.org").executeTakeFirst();
    expect(user).toEqual({ email: "ada@example.org", name: "Ada Lovelace" });
  });

  it("create for an existing email says a new link was issued and the old one no longer works", async () => {
    await users(["create", "--email", "bo@example.org", "--name", "Bo", "--role", "member"]);
    const again = await users(["create", "--email", "bo@example.org", "--name", "Bo", "--role", "member"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/already has a login/i);
    expect(again.stdout).toMatch(/setup#/);
  });

  it("create --person-id links an existing person", async () => {
    const person = await migrator.insertInto("people").values({ display_name: "Cy" }).returning("id").executeTakeFirstOrThrow();
    const result = await users(["create", "--email", "cy@example.org", "--name", "Cy", "--role", "member", "--person-id", person.id]);
    expect(result.code).toBe(0);
    const user = await migrator.selectFrom("users").innerJoin("auth_users", "auth_users.id", "users.id").select("users.person_id").where("auth_users.email", "=", "cy@example.org").executeTakeFirstOrThrow();
    expect(user.person_id).toBe(person.id);
  });

  it("deactivate removes the login's sign-in data and says so; an unknown email exits 1", async () => {
    await users(["create", "--email", "di@example.org", "--name", "Di", "--role", "member"]);
    const result = await users(["deactivate", "--email", "di@example.org"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/deactivated/i);
    expect(await migrator.selectFrom("auth_users").select("id").where("email", "=", "di@example.org").executeTakeFirst()).toBeUndefined();
    const unknown = await users(["deactivate", "--email", "nobody@example.org"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/no active login/i);
  });

  it.each([
    [["create", "--email", "x@example.org", "--name", "X"], /--role/],
    [["create", "--email", "x@example.org", "--name", "X", "--role", "root"], /role/],
    [["create", "--email", "nope", "--name", "X", "--role", "member"], /email/],
    [["deactivate"], /--email/],
    [["sideways"], /usage/i],
    [["create", "--email", "x@example.org", "--name", "X", "--role", "member", "--bogus", "1"], /usage|unknown/i],
  ])("%j exits 1 with a usage or field message", async (args, message) => {
    const result = await users(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(message);
  });

  it("errors never echo the email or the database URL", async () => {
    // Built at run time so this file never holds a connection-string-shaped literal (secretlint).
    const unreachable = ["postgres://vault_app:", "s3cretpw", "@127.0.0.1:1/vault"].join("");
    const result = await users(["create", "--email", "eve@example.org", "--name", "Eve", "--role", "member"], { DATABASE_URL: unreachable, APP_URL });
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("s3cretpw");
    expect(result.stderr).not.toContain("eve@example.org");
  });

  it("refuses to start without APP_URL (the link would be wrong)", async () => {
    const result = await users(["create", "--email", "f@example.org", "--name", "F", "--role", "member"], { DATABASE_URL: fresh.appUrl });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("APP_URL");
  });
});
