import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const project = process.env.COMPOSE_PROJECT_NAME ?? "asset-vault";

/** `pnpm user:create` for an email that may already have a login: returns the new setup path (/setup#<token>). */
export async function issueLink(email: string, name: string, role: "admin" | "member" = "member"): Promise<{ setupPath: string; output: string }> {
  const { stdout } = await run("docker", ["compose", "-p", project, "exec", "-T", "worker", "node", "packages/db/src/users-cli.ts", "create", "--email", email, "--name", name, "--role", role], { timeout: 60_000 });
  const link = /https?:\/\/\S+\/setup#[A-Za-z0-9_-]{43}/.exec(stdout)?.[0];
  if (!link) throw new Error("No setup link in the CLI output");
  const url = new URL(link);
  return { setupPath: `${url.pathname}${url.hash}`, output: stdout };
}

/** A psql statement as the superuser, on the stack under test (for ageing sessions and reading rows). */
export async function psql(sql: string): Promise<string> {
  const { stdout } = await run("docker", ["compose", "-p", project, "exec", "-T", "postgres", "sh", "-c", `psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"`, "sh", sql], { timeout: 60_000 });
  return stdout.trim();
}
