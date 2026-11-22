// The admin's server commands (design note M1.3: no public sign-up). Run in the
// worker image as vault_app, like the worker itself (README, "Users"):
//
//   pnpm user:create --email … --name … --role admin|member [--person-id <uuid>]
//   pnpm user:deactivate --email …
//
// The setup link is printed to this terminal only (never logged). Its token is in
// the URL fragment, so it never reaches a server or proxy log.
import { parseArgs } from "node:util";
import { ValidationError } from "./access.ts";
import { createLogin, deactivateLogin, LoginConflictError } from "./auth/logins.ts";
import { createDb } from "./client.ts";
import { loadDbConfig } from "./config.ts";
import { errorCode } from "./log.ts";
import type { Role } from "./schema.ts";

const USAGE = `usage:
  users-cli.ts create --email <email> --name <name> --role admin|member [--person-id <uuid>]
  users-cli.ts deactivate --email <email>
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function appUrl(env: Record<string, string | undefined>): string {
  try {
    const url = new URL(env.APP_URL ?? "");
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
  } catch {
    // fall through
  }
  return fail("APP_URL is required: the address people open the app at, e.g. https://vault.example.org");
}

const [command, ...rest] = process.argv.slice(2);
if (command !== "create" && command !== "deactivate") fail(USAGE);

let values: Record<string, string | undefined>;
try {
  ({ values } = parseArgs({
    args: rest,
    options: { email: { type: "string" }, name: { type: "string" }, role: { type: "string" }, "person-id": { type: "string" } },
    strict: true,
    allowPositionals: false,
  }) as { values: Record<string, string | undefined> });
} catch {
  fail(`Unknown or malformed option.\n${USAGE}`);
}
if (!values.email) fail(`--email is required.\n${USAGE}`);
if (command === "create" && (!values.name || !values.role)) fail(`--name and --role are required.\n${USAGE}`);

let databaseUrl: string;
try {
  databaseUrl = loadDbConfig(process.env).databaseUrl;
} catch (error) {
  fail((error as Error).message);
}
const link = command === "create" ? appUrl(process.env) : "";

const db = createDb(databaseUrl, { maxConnections: 1 });
try {
  if (command === "create") {
    const created = await createLogin(db, {
      email: values.email,
      name: values.name!,
      role: values.role as Role,
      personId: values["person-id"] ?? null,
    });
    const intro = created.reissued
      ? "This email already has a login. A new setup link was issued; the old one no longer works.\nEvery session, the authenticator and the backup codes were ended now. The link sets a new password and a new authenticator."
      : "Login created.";
    process.stdout.write(
      `${intro}\nGive this one-time setup link to the person (valid for 24 hours, until ${created.expiresAt.toISOString()}):\n\n` +
        `${link}/setup#${created.setupToken}\n\n`,
    );
  } else {
    if (!(await deactivateLogin(db, values.email))) fail("No active login has that email. Nothing was changed.");
    process.stdout.write("Login deactivated: its password, authenticator, backup codes, sessions and setup links are deleted.\n");
  }
} catch (error) {
  // Item e: field names or a code only; never the email, the name or the database URL.
  if (error instanceof ValidationError) fail(`Invalid ${error.fields.join(", ")}.`);
  if (error instanceof LoginConflictError) fail(error.message);
  const code = errorCode(error);
  process.exitCode = 1;
  process.stderr.write(`${command} failed${code ? ` (${code})` : ""}.\n`);
} finally {
  await db.destroy();
}
