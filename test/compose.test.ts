import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

// Trust-boundary checks from the M1 design note: Postgres is not published to the
// host, the web app is bound to 127.0.0.1 only, config comes from env.
const run = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = path.join(repo, "docker-compose.yml");
// An empty project directory so a developer's local .env is never read.
const emptyDir = mkdtempSync(path.join(tmpdir(), "vault-compose-"));
afterAll(() => rmSync(emptyDir, { recursive: true, force: true }));

type Service = {
  ports?: { host_ip?: string; published?: string; target: number }[];
  environment?: Record<string, string>;
  privileged?: boolean;
  network_mode?: string;
  env_file?: unknown;
  volumes?: { source?: string; target: string; type: string }[];
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: unknown;
  restart?: string;
};

async function config(env: Record<string, string>): Promise<{ services: Record<string, Service> }> {
  const { stdout } = await run(
    "docker",
    ["compose", "-f", compose, "--project-directory", emptyDir, "config", "--format", "json"],
    { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } },
  );
  return JSON.parse(stdout);
}

describe("docker-compose.yml trust boundaries (tester)", () => {
  it("does not publish Postgres or the worker to the host", async () => {
    const { services } = await config({ POSTGRES_PASSWORD: "pw12345" });
    expect(services.postgres?.ports ?? []).toEqual([]);
    expect(services.worker?.ports ?? []).toEqual([]);
  });

  it("publishes only the web app, on 127.0.0.1, container port 3000", async () => {
    const { services } = await config({ POSTGRES_PASSWORD: "pw12345" });
    const published = Object.entries(services).flatMap(([name, s]) => (s.ports ?? []).map((p) => ({ name, ...p })));
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ name: "web", host_ip: "127.0.0.1", target: 3000 });
  });

  it("keeps the 127.0.0.1 binding when WEB_PORT is overridden, and ignores a hostile WEB_HOST-style override", async () => {
    const { services } = await config({ POSTGRES_PASSWORD: "pw12345", WEB_PORT: "4123", HOST: "0.0.0.0", WEB_HOST: "0.0.0.0" });
    expect(services.web?.ports).toEqual([expect.objectContaining({ host_ip: "127.0.0.1", published: "4123", target: 3000 })]);
  });

  it("refuses to start without POSTGRES_PASSWORD (no default password), and the error does not need a value", async () => {
    await expect(config({})).rejects.toMatchObject({ stderr: expect.stringContaining("POSTGRES_PASSWORD") });
  });

  it("refuses to start from an unedited copy of .env.example (reviewer L4)", async () => {
    const copied = path.join(emptyDir, ".env");
    copyFileSync(path.join(repo, ".env.example"), copied);
    try {
      await expect(config({})).rejects.toMatchObject({ stderr: expect.stringContaining("POSTGRES_PASSWORD") });
    } finally {
      rmSync(copied);
    }
  });

  it("refuses an empty POSTGRES_PASSWORD", async () => {
    await expect(config({ POSTGRES_PASSWORD: "" })).rejects.toMatchObject({ stderr: expect.stringContaining("POSTGRES_PASSWORD") });
  });

  it("gives web and worker DATABASE_URL via environment only, pointing at the postgres service", async () => {
    const password = "pw12345";
    const { services } = await config({ POSTGRES_PASSWORD: password });
    for (const name of ["web", "worker"]) {
      expect(services[name]?.environment?.DATABASE_URL).toBe(`postgres://vault:${password}@postgres:5432/vault`);
      expect(services[name]?.env_file).toBeUndefined();
    }
  });

  it("does not give any service host networking or privileges", async () => {
    const { services } = await config({ POSTGRES_PASSWORD: "pw12345" });
    for (const s of Object.values(services)) {
      expect(s.privileged).toBeFalsy();
      expect(s.network_mode).toBeUndefined();
    }
  });

  it("does not bind-mount host paths (data lives in a named volume)", async () => {
    const { services } = await config({ POSTGRES_PASSWORD: "pw12345" });
    for (const s of Object.values(services)) {
      for (const v of s.volumes ?? []) expect(v.type).toBe("volume");
    }
  });

  it("starts web and worker only after Postgres is healthy, and all three restart and have healthchecks", async () => {
    const { services } = await config({ POSTGRES_PASSWORD: "pw12345" });
    for (const name of ["web", "worker"]) {
      expect(services[name]?.depends_on?.postgres?.condition).toBe("service_healthy");
    }
    for (const name of ["postgres", "web", "worker"]) {
      expect(services[name]?.restart).toBe("unless-stopped");
      expect(services[name]?.healthcheck).toBeDefined();
    }
  });
});
