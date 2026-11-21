import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

// Trust boundary: Postgres and the worker are not reachable from the host or the
// LAN; the web app only on loopback. Checked on the running stack.
const run = promisify(execFile);
const project = process.env.COMPOSE_PROJECT_NAME ?? "asset-vault";
const webPort = Number(process.env.WEB_PORT ?? "3000");

type Row = { Service: string; Publishers?: { URL: string; TargetPort: number; PublishedPort: number; Protocol: string }[] | null };

async function rows(): Promise<Row[]> {
  const { stdout } = await run("docker", ["compose", "-p", project, "ps", "--format", "json"]);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
}

function tryConnect(host: string, port: number): Promise<"open" | "refused" | "timeout"> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 2_000 });
    socket.once("connect", () => (socket.destroy(), resolve("open")));
    socket.once("timeout", () => (socket.destroy(), resolve("timeout")));
    socket.once("error", () => (socket.destroy(), resolve("refused")));
  });
}

test("all three services are running and healthy", async () => {
  const { stdout } = await run("docker", ["compose", "-p", project, "ps", "--format", "{{.Service}}={{.Health}}"]);
  const status = Object.fromEntries(stdout.trim().split("\n").map((l) => l.split("=")));
  expect(Object.keys(status).sort()).toEqual(["postgres", "web", "worker"]);
  for (const [, health] of Object.entries(status)) expect(health).toBe("healthy");
});

test("docker compose ps: only web publishes a port, and only on 127.0.0.1", async () => {
  const published = (await rows()).flatMap((r) =>
    (r.Publishers ?? []).filter((p) => p.PublishedPort > 0).map((p) => ({ service: r.Service, ...p })),
  );
  expect(published.map((p) => p.service)).toEqual(["web"]);
  expect(published[0]).toMatchObject({ URL: "127.0.0.1", TargetPort: 3000, PublishedPort: webPort });
});

test("Postgres publishes nothing to the host (no 5432 mapping)", async () => {
  const postgres = (await rows()).find((r) => r.Service === "postgres");
  expect((postgres?.Publishers ?? []).filter((p) => p.PublishedPort > 0)).toEqual([]);
  const { stdout: id } = await run("docker", ["compose", "-p", project, "ps", "-q", "postgres"]);
  const { stdout } = await run("docker", ["inspect", id.trim(), "--format", "{{json .NetworkSettings.Ports}}"]);
  const ports = JSON.parse(stdout) as Record<string, { HostIp: string; HostPort: string }[] | null>;
  for (const [containerPort, bindings] of Object.entries(ports)) {
    expect(bindings ?? [], `postgres ${containerPort} must have no host binding`).toEqual([]);
  }
});

test("the web app answers on loopback but not on a LAN address", async () => {
  expect(await tryConnect("127.0.0.1", webPort)).toBe("open");
  const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i!.address);
  for (const address of lan) expect(await tryConnect(address, webPort), `web on ${address}:${webPort}`).not.toBe("open");
});

test("containers run as non-root where the image allows it (web, worker)", async () => {
  for (const service of ["web", "worker"]) {
    const { stdout } = await run("docker", ["compose", "-p", project, "exec", "-T", service, "id", "-u"]);
    expect(stdout.trim(), service).not.toBe("0");
  }
});
