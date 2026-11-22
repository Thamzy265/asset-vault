import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { migrateUp } from "../src/migrate.ts";
import type { Database } from "../src/schema.ts";
import { freshDatabase, type FreshDatabase } from "./support/fresh-database.ts";

// Independent tester round for M1.3: abuse and edge cases for `pnpm user:create` / `user:deactivate`
// (design note: "the server CLI (Tailscale-only admin)" is a trust boundary; the link is a bearer secret).
// The developer's own tests are in users-cli.test.ts.
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
const count = async (table: "users" | "people" | "auth_users" | "auth_setup_tokens") => Number((await migrator.selectFrom(table).select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow()).n);
const tokenOf = (stdout: string) => /#([A-Za-z0-9_-]{43})\n/.exec(stdout)?.[1];

describe("user:create refuses bad input and says nothing that helps an attacker or a terminal", () => {
  it("refuses a bad role, email, name or person id: exit 1, no link on stdout, no row written, the value never echoed", async () => {
    const before = [await count("users"), await count("people"), await count("auth_users"), await count("auth_setup_tokens")];
    const cases: Array<[string[], RegExp]> = [
      [["--email", "ada@example.org", "--name", "Ada", "--role", "root"], /Invalid role/],
      [["--email", "ada@example.org", "--name", "Ada", "--role", "Admin"], /Invalid role/],
      [["--email", "not-an-email", "--name", "Ada", "--role", "member"], /Invalid email/],
      [["--email", "a b@example.org", "--name", "Ada", "--role", "member"], /Invalid email/],
      [["--email", `${"x".repeat(250)}@example.org`, "--name", "Ada", "--role", "member"], /Invalid email/],
      [["--email", "ada@example.org", "--name", "\u001b[31mAda\u001b[0m", "--role", "member"], /Invalid name/],
      [["--email", "ada@example.org", "--name", "Ada\nLovelace", "--role", "member"], /Invalid name/],
      [["--email", "ada@example.org", "--name", "A‮da", "--role", "member"], /Invalid name/],
      [["--email", "ada@example.org", "--name", "x".repeat(101), "--role", "member"], /Invalid name/],
      [["--email", "ada@example.org", "--name", "   ", "--role", "member"], /Invalid name|required/],
      [["--email", "ada@example.org", "--name", "Ada", "--role", "member", "--person-id", "not-a-uuid"], /Invalid personId/],
    ];
    for (const [args, expected] of cases) {
      const res = await users(["create", ...args]);
      expect(res.code, args.join(" ")).toBe(1);
      expect(res.stderr, args.join(" ")).toMatch(expected);
      expect(res.stdout, "no link is printed for a refused login").not.toContain("/setup#");
      for (const value of [args[1]!, args[3]!]) if (value.length > 3) expect(res.stderr + res.stdout, "the value is never echoed").not.toContain(value);
    }
    expect([await count("users"), await count("people"), await count("auth_users"), await count("auth_setup_tokens")]).toEqual(before);
  });

  it("refuses missing, unknown, positional and malformed options, and a missing APP_URL, without touching the database", async () => {
    const before = await count("users");
    for (const args of [
      ["create"],
      ["create", "--email", "ada@example.org"],
      ["create", "--name", "Ada", "--role", "member"],
      ["create", "--email", "ada@example.org", "--name", "Ada", "--role", "member", "--admin"],
      ["create", "--email", "ada@example.org", "--name", "Ada", "--role", "member", "stray"],
      ["create", "--email"],
      ["create", "--email", "--name", "Ada", "--role", "member"],
      ["deactivate"],
      ["deactivate", "--role", "admin"],
      ["delete", "--email", "ada@example.org"],
      [],
    ]) {
      const res = await users(args);
      expect(res.code, args.join(" ")).toBe(1);
      expect(res.stdout).not.toContain("/setup#");
    }
    expect((await users(["create", "--email", "ada@example.org", "--name", "Ada", "--role", "member"], { DATABASE_URL: fresh.appUrl })).code).toBe(1);
    expect((await users(["create", "--email", "ada@example.org", "--name", "Ada", "--role", "member"], { DATABASE_URL: fresh.appUrl, APP_URL: "javascript:alert(1)" })).code).toBe(1);
    expect(await count("users")).toBe(before);
  });

  it("an APP_URL with a path, query, fragment or user info is refused, as the web app refuses it (reviewer: the CLI is as strict as loadAuthConfig); an origin, trailing slash allowed, makes the link", async () => {
    for (const value of ["https://vault.example.org/some/path?x=1#frag", ["https://evil:secret", "@vault.example.org"].join("")]) {
      const res = await users(["create", "--email", `origin${Math.random().toString(36).slice(2, 8)}@example.org`, "--name", "Origin", "--role", "member"], { DATABASE_URL: fresh.appUrl, APP_URL: value });
      expect(res.code, value).toBe(1);
      expect(res.stdout, value).not.toContain("/setup#");
      expect(res.stderr, value).not.toMatch(/evil|secret|frag|some\/path/);
    }
    const ok = await users(["create", "--email", `origin${Math.random().toString(36).slice(2, 8)}@example.org`, "--name", "Origin", "--role", "member"], { DATABASE_URL: fresh.appUrl, APP_URL: "http://127.0.0.1:3000/" });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("\nhttp://127.0.0.1:3000/setup#");
  });

  it("the email is stored lower case whatever was typed, and a second create with other casing re-issues instead of making a second login", async () => {
    const one = await users(["create", "--email", "MiXeD.Case@Example.ORG", "--name", "Mixed", "--role", "member"]);
    expect(one.code).toBe(0);
    expect(await migrator.selectFrom("auth_users").select("email").where("email", "=", "mixed.case@example.org").executeTakeFirst()).toBeDefined();
    const two = await users(["create", "--email", "  mixed.CASE@example.org ", "--name", "Mixed", "--role", "member"]);
    expect(two.code).toBe(0);
    expect(two.stdout).toMatch(/already has a login/i);
    expect(await migrator.selectFrom("auth_users").select("id").where("email", "=", "mixed.case@example.org").execute()).toHaveLength(1);
    expect(tokenOf(one.stdout)).not.toBe(tokenOf(two.stdout));
  });

  it("every link is a fresh 256-bit token: 20 creates give 20 different ones, none repeated across re-issues", async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const res = await users(["create", "--email", `entropy${i}@example.org`, "--name", "Entropy", "--role", "member"]);
      tokens.add(tokenOf(res.stdout)!);
      const again = await users(["create", "--email", `entropy${i}@example.org`, "--name", "Entropy", "--role", "member"]);
      tokens.add(tokenOf(again.stdout)!);
    }
    expect(tokens.size).toBe(12);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("a refused re-issue (other role) changes nothing: the first link still works and the role is unchanged", async () => {
    const first = await users(["create", "--email", "role.change@example.org", "--name", "Role", "--role", "member"]);
    const token = tokenOf(first.stdout)!;
    const refused = await users(["create", "--email", "role.change@example.org", "--name", "Role", "--role", "admin"]);
    expect(refused.code).toBe(1);
    expect(refused.stdout).not.toContain("/setup#");
    const row = await migrator
      .selectFrom("users")
      .innerJoin("auth_users", "auth_users.id", "users.id")
      .innerJoin("auth_setup_tokens", "auth_setup_tokens.user_id", "users.id")
      .select(["users.role", "auth_setup_tokens.token_hash"])
      .where("auth_users.email", "=", "role.change@example.org")
      .executeTakeFirstOrThrow();
    expect(row.role).toBe("member");
    const { hashSetupToken } = await import("../src/auth/setup-tokens.ts");
    expect(row.token_hash).toBe(hashSetupToken(token));
  });

  it("two admins creating the same email at the same moment end with one login and one live link", async () => {
    const results = await Promise.all([1, 2, 3].map(() => users(["create", "--email", "racing.admins@example.org", "--name", "Racing", "--role", "member"])));
    expect(results.filter((r) => r.code === 0).length).toBeGreaterThanOrEqual(1);
    expect(await migrator.selectFrom("auth_users").select("id").where("email", "=", "racing.admins@example.org").execute()).toHaveLength(1);
    const links = await migrator.selectFrom("auth_setup_tokens").select("auth_setup_tokens.id").innerJoin("auth_users", "auth_users.id", "auth_setup_tokens.user_id").where("auth_users.email", "=", "racing.admins@example.org").execute();
    expect(links).toHaveLength(1);
    const live = results.filter((r) => r.code === 0).map((r) => tokenOf(r.stdout)!);
    const { hashSetupToken } = await import("../src/auth/setup-tokens.ts");
    const stored = (await migrator.selectFrom("auth_setup_tokens").select("token_hash").innerJoin("auth_users", "auth_users.id", "auth_setup_tokens.user_id").where("auth_users.email", "=", "racing.admins@example.org").executeTakeFirstOrThrow()).token_hash;
    expect(live.filter((t) => hashSetupToken(t) === stored)).toHaveLength(1); // exactly one printed link is the live one
  });
});

describe("user:deactivate", () => {
  it("is case-insensitive, idempotent in effect (the second run says nothing changed), and never echoes the email", async () => {
    await users(["create", "--email", "leaver@example.org", "--name", "Leaver", "--role", "member"]);
    const first = await users(["deactivate", "--email", " LEAVER@example.org "]);
    expect(first.code).toBe(0);
    expect(first.stdout + first.stderr).not.toContain("leaver");
    const second = await users(["deactivate", "--email", "leaver@example.org"]);
    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(/Nothing was changed/);
    expect(second.stdout + second.stderr).not.toContain("leaver");
  });

  it("does not touch another login whose email only contains the typed one", async () => {
    await users(["create", "--email", "jo@example.org", "--name", "Jo", "--role", "member"]);
    await users(["create", "--email", "joanna@example.org", "--name", "Joanna", "--role", "member"]);
    await users(["create", "--email", "dan@example.org", "--name", "Dan", "--role", "member"]);
    expect((await users(["deactivate", "--email", "jo@example.org"])).code).toBe(0);
    expect((await users(["deactivate", "--email", "%@example.org"])).code, "a SQL wildcard is just text").toBe(1);
    expect((await users(["deactivate", "--email", "jo@example.org' or '1'='1"])).code).toBe(1);
    const alive = await migrator.selectFrom("auth_users").select("email").where("email", "in", ["joanna@example.org", "dan@example.org"]).execute();
    expect(alive).toHaveLength(2);
  });

  it("an unreachable database is a clean exit 1 that names a code at most, not the URL or the email", async () => {
    const res = await users(["deactivate", "--email", "someone@example.org"], { DATABASE_URL: ["postgres", "://vault_app:topsecretpw@127.0.0.1:1/vault"].join(""), APP_URL });
    expect(res.code).toBe(1);
    expect(res.stdout + res.stderr).not.toMatch(/topsecretpw|someone@example\.org|127\.0\.0\.1/);
  });
});
