import { spawn } from "node:child_process";
import { expect, test } from "@playwright/test";

// Design note, failure plan: database unreachable at start -> retry with backoff for
// ~60 s, then exit non-zero. Runs the real worker entry point against a closed port.
const SECRET = "retrypw98765";

test("worker retries for about 60 s with capped backoff, then exits 1 without printing the password", async () => {
  test.setTimeout(100_000);
  const started = Date.now();
  const child = spawn(process.execPath, ["apps/worker/src/main.ts"], {
    env: { PATH: process.env.PATH ?? "", DATABASE_URL: `postgres://vault:${SECRET}@127.0.0.1:1/vault` },
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  const seconds = (Date.now() - started) / 1000;

  expect(code).toBe(1);
  expect(seconds).toBeGreaterThan(55);
  expect(seconds).toBeLessThan(75);
  expect(output).not.toContain(SECRET);

  const lines = output.trim().split("\n").map((l) => JSON.parse(l) as { msg: string; delayMs?: number; level: string });
  const retries = lines.filter((l) => l.msg === "database not reachable, retrying");
  expect(retries.length).toBeGreaterThan(10); // many attempts, not one long sleep
  for (const r of retries) expect(r.delayMs).toBeLessThanOrEqual(5_000); // capped
  expect(lines.at(-1)).toMatchObject({ level: "error", msg: "worker failed to start" });
});
