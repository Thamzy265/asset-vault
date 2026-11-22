import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { PASSWORD } from "./support/accounts.ts";

// Independent tester round for M1.3 (item e, Privacy section): after the whole e2e run, nothing the
// web, worker and migrate containers logged holds an email, a password, a code, a token, a cookie,
// a request path or a Postgres detail. The file is named *.destructive.spec.ts only so that it runs
// after every other spec (see the "destructive" project in playwright.config.ts); it stops nothing.
const run = promisify(execFile);
const project = process.env.COMPOSE_PROJECT_NAME ?? "asset-vault";

async function logs(service: string): Promise<string[]> {
  const { stdout } = await run("docker", ["compose", "-p", project, "logs", "--no-log-prefix", "--no-color", service], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\n").filter(Boolean);
}

async function envOf(service: string, name: string): Promise<string> {
  const { stdout } = await run("docker", ["compose", "-p", project, "exec", "-T", service, "sh", "-c", `printf %s "$${name}"`], { timeout: 60_000 });
  return stdout;
}

test("web, worker and migrate logs hold no personal data, secret, cookie, token or request path", async () => {
  await new Promise((r) => setTimeout(r, 1500));
  const byService = { web: await logs("web"), worker: await logs("worker"), migrate: await logs("migrate") };
  const key = await envOf("web", "AUTH_ENCRYPTION_KEY");
  const dbUrl = await envOf("web", "DATABASE_URL");
  const dbPassword = /:\/\/[^:]+:([^@]+)@/.exec(dbUrl)?.[1] ?? "";
  expect(key.length).toBeGreaterThanOrEqual(32);
  expect(dbPassword.length).toBeGreaterThan(8);
  expect(byService.web.length, "the web log has the request lines this run produced").toBeGreaterThan(20);

  // Plain checks collected in a list: thousands of lines, one assertion at the end.
  const problems: string[] = [];
  const banned: Array<[string, (line: string) => boolean]> = [
    ["an email address", (l) => /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(l)],
    ["a password", (l) => l.includes(PASSWORD) || l.includes("a different long password")],
    ["the encryption key", (l) => l.includes(key)],
    ["the database password", (l) => l.includes(dbPassword)],
    ["a cookie or header name", (l) => /session_token|session_data|two_factor|set-cookie|authorization|bearer /i.test(l)],
    ["a Postgres detail", (l) => /Key \(.*\)=\(|violates (unique|foreign|check)|DETAIL:|duplicate key/i.test(l)],
  ];
  const allowedRoutes = ["/api/v1/*", "/api/v1/me", "/api/v1/health"];
  for (const [service, lines] of Object.entries(byService)) {
    for (const line of lines) {
      for (const [what, test] of banned) if (test(line)) problems.push(`${service}: ${what}: ${line.slice(0, 120)}`);
      if (!line.startsWith("{")) continue;
      // Structured lines: no 43-character base64url token (a setup link), no raw request path, no personal field.
      if (/[A-Za-z0-9_-]{43}/.test(line)) problems.push(`${service}: a token-like string: ${line.slice(0, 120)}`);
      if (/%2e%2e|%2f|attackerchosen|jsessionid|evil\.example|\.\.\//i.test(line)) problems.push(`${service}: a request path: ${line.slice(0, 120)}`);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      for (const field of ["email", "password", "code", "token", "cookie", "secret", "path", "url", "query", "name", "body"]) if (field in parsed) problems.push(`${service}: field ${field}: ${line.slice(0, 120)}`);
      if (parsed.msg === "api request" && !allowedRoutes.includes(String(parsed.route))) problems.push(`${service}: route ${String(parsed.route)}`);
    }
  }
  expect(problems.slice(0, 10)).toEqual([]);
});

test("every /api/v1 request line has the documented fields only: request id, route pattern, method, status, duration", async () => {
  const lines = (await logs("web")).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === "api request");
  expect(lines.length).toBeGreaterThan(10);
  for (const l of lines) {
    expect(Object.keys(l).sort()).toEqual(["durationMs", "level", "method", "msg", "requestId", "route", "status", "time"]);
    expect(l.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  }
});
