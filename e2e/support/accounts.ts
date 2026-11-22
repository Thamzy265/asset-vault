import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);
const project = process.env.COMPOSE_PROJECT_NAME ?? "asset-vault";

/** The admin's command on the running stack (pnpm user:create runs the same CLI in the worker image). */
async function usersCli(...args: string[]): Promise<string> {
  const { stdout } = await run("docker", ["compose", "-p", project, "exec", "-T", "worker", "node", "packages/db/src/users-cli.ts", ...args], { timeout: 60_000 });
  return stdout;
}

/** A new login; returns the setup link path (/setup#<token>) and the email. */
export async function newLogin(name = "Test Person", role: "admin" | "member" = "member"): Promise<{ email: string; setupPath: string }> {
  const email = `e2e-${randomUUID().slice(0, 8)}@example.org`;
  const out = await usersCli("create", "--email", email, "--name", name, "--role", role);
  const link = /https?:\/\/\S+\/setup#[A-Za-z0-9_-]{43}/.exec(out)?.[0];
  if (!link) throw new Error("No setup link in the CLI output");
  const url = new URL(link);
  return { email, setupPath: `${url.pathname}${url.hash}` };
}

export async function deactivate(email: string): Promise<void> {
  await usersCli("deactivate", "--email", email);
}

export const PASSWORD = "correct horse battery staple";
