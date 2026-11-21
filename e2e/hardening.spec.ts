import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

// Reviewer L5, checked on the running stack: the app processes run as uid 1000
// and can't change their own code, and have no Linux capabilities.
const run = promisify(execFile);
const project = process.env.COMPOSE_PROJECT_NAME ?? "asset-vault";
const exec = (service: string, ...cmd: string[]) => run("docker", ["compose", "-p", project, "exec", "-T", service, ...cmd]);

// Checks write permission without writing anything, so a failure leaves the container intact.
const probe = (paths: string[]) =>
  `const fs=require("fs");const w=[];for(const p of ${JSON.stringify(paths)}){try{fs.accessSync(p,fs.constants.W_OK);w.push(p)}catch{}}console.log(JSON.stringify(w))`;

const appPaths = {
  web: ["/app", "/app/apps/web", "/app/apps/web/server.js", "/app/apps/web/.next", "/app/node_modules"],
  worker: ["/app", "/app/apps/worker/src", "/app/apps/worker/src/main.ts", "/app/packages/db/src", "/app/node_modules"],
};

for (const [service, paths] of Object.entries(appPaths)) {
  test(`${service}: runs as uid 1000 and can't write to its app directory`, async () => {
    expect((await exec(service, "id", "-u")).stdout.trim()).toBe("1000");
    const { stdout } = await exec(service, "node", "-e", probe(paths));
    expect(JSON.parse(stdout), "paths writable by the app user").toEqual([]);
  });

  test(`${service}: processes have no capabilities, no-new-privileges is set, and an init is PID 1`, async () => {
    expect((await exec(service, "cat", "/proc/1/comm")).stdout.trim()).toBe("docker-init");
    const { stdout } = await exec(service, "sh", "-c", "grep -E '^(CapEff|CapBnd|NoNewPrivs):' /proc/self/status");
    const status = Object.fromEntries(stdout.trim().split("\n").map((l) => l.split(/:\s+/)));
    expect(status).toEqual({ CapEff: "0000000000000000", CapBnd: "0000000000000000", NoNewPrivs: "1" });
  });
}
