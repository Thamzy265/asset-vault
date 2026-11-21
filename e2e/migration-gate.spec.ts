import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

// Migration gate (review L7, M1.2 AC5), on a throwaway copy of the stack: its
// own project name, port and volume, removed afterwards. It reuses the images
// of the stack under test (`docker compose up --build` must have run).
const run = promisify(execFile);
const images = process.env.COMPOSE_PROJECT_NAME ?? "asset-vault";
const gate = `${images}-gate-${randomBytes(3).toString("hex")}`;
const password = randomBytes(12).toString("hex");
const port = String(40_000 + Math.floor(Math.random() * 20_000));
const envDir = mkdtempSync(path.join(tmpdir(), "vault-gate-"));
const emptyEnv = path.join(envDir, "empty.env");
writeFileSync(emptyEnv, "");

const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", POSTGRES_PASSWORD: password, WEB_PORT: port, VAULT_IMAGES: images };
const compose = (...args: string[]) =>
  run("docker", ["compose", "-p", gate, "--env-file", emptyEnv, "-f", "docker-compose.yml", "-f", "e2e/fixtures/reuse-images.compose.yml", ...args], {
    env,
    timeout: 150_000,
  });

type Row = { Service: string; State: string; ExitCode: number };
async function states(): Promise<Record<string, Row>> {
  const { stdout } = await compose("ps", "-a", "--format", "json");
  const rows = stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
  return Object.fromEntries(rows.map((r) => [r.Service, r]));
}

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

test.afterAll(async () => {
  await compose("down", "-v", "--remove-orphans").catch(() => {});
  rmSync(envDir, { recursive: true, force: true });
});

test("a failing migration keeps web and worker from starting", async () => {
  await compose("up", "-d", "--wait", "postgres");
  // A table in the way makes migration 0002 fail (42P07 duplicate_table).
  await compose("exec", "-T", "postgres", "psql", "-U", "vault", "-d", "vault", "-c", "create table people (id int)");

  const up = await compose("up", "-d", "--wait", "--no-build").then(
    () => ({ ok: true, stderr: "" }),
    (e: { stderr: string }) => ({ ok: false, stderr: e.stderr }),
  );
  expect(up.ok).toBe(false);
  expect(up.stderr).toMatch(/migrate/);

  const s = await states();
  expect(s.migrate).toMatchObject({ State: "exited", ExitCode: 1 });
  expect(s.web?.State ?? "absent").not.toBe("running");
  expect(s.worker?.State ?? "absent").not.toBe("running");

  const { stdout } = await compose("logs", "--no-log-prefix", "migrate");
  expect(stdout).toContain('"msg":"migrate up failed"');
  expect(stdout).toContain('"code":"42P07"');
  expect(stdout).not.toContain(password);
});

test("once the migration can run, web and worker start; health is 503 while the schema is behind the code", async ({ request }) => {
  await compose("exec", "-T", "postgres", "psql", "-U", "vault", "-d", "vault", "-c", "drop table people");
  await compose("up", "-d", "--wait", "--no-build");
  const s = await states();
  expect(s.migrate).toMatchObject({ State: "exited", ExitCode: 0 });
  expect(s.web?.State).toBe("running");
  expect(s.worker?.State).toBe("running");

  const health = `http://127.0.0.1:${port}/api/v1/health`;
  const ok = await (await request.get(health)).json();
  expect(ok).toMatchObject({ status: "ok", schema: { applied: ok.schema.expected } });

  await compose("run", "--rm", "--no-deps", "migrate", "node", "packages/db/src/cli.ts", "down");
  const behind = await request.get(health);
  expect(behind.status()).toBe(503);
  const body = await behind.json();
  expect(body).toMatchObject({ status: "error", db: "ok" });
  expect(body.schema.applied).not.toBe(body.schema.expected);

  await compose("run", "--rm", "--no-deps", "migrate");
  expect((await request.get(health)).status()).toBe(200);
});
