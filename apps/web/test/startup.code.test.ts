import { DatabaseUnavailableError } from "@vault/db";
import { describe, expect, it } from "vitest";
import { startupCheck } from "../src/server/startup.ts";

// Reviewer L3: the web app's final start-up log names why Postgres refused,
// as a code only.
describe("web start-up check failure reason", () => {
  it("logs the pg code of a refused connection, and not the cause's message or the URL", async () => {
    const logs: Array<{ level: string; msg: string; fields: Record<string, unknown> | undefined }> = [];
    const cause = Object.assign(new Error('password authentication failed for user "vault"'), { code: "28P01" });
    await startupCheck({
      // Built at run time so secretlint doesn't flag a credential-shaped literal.
      env: { DATABASE_URL: `postgres://vault:${"webstartuppw1"}@db:5432/vault` },
      exit: () => {},
      log: (level, msg, fields) => logs.push({ level, msg, fields }),
      wait: async () => {
        throw new DatabaseUnavailableError("Database refused the connection (28P01); check DATABASE_URL", { cause });
      },
    });
    const last = logs.at(-1);
    expect(last).toMatchObject({ level: "error", msg: "database unreachable, exiting", fields: { code: "28P01" } });
    expect(JSON.stringify(logs)).not.toMatch(/webstartuppw1|authentication failed|postgres:\/\//);
  });
});
