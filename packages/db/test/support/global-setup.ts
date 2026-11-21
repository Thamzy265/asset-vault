import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import type { TestProject } from "vitest/node";
import "./fresh-database.ts";

// Same image as docker-compose.yml. Set TEST_DATABASE_URL to use an existing
// throwaway server instead of starting a container (its superuser is used to
// create the vault_migrator and vault_app roles if they are missing).
export const POSTGRES_IMAGE = "postgres:18.7-alpine3.24";
const ROLES_SCRIPT = fileURLToPath(new URL("../../initdb/10-vault-roles.sh", import.meta.url));

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject) {
  // Fresh random passwords every run; they exist only in this test run.
  const migratorPassword = randomBytes(18).toString("hex");
  const appPassword = randomBytes(18).toString("hex");
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    // The container runs the same init script as Compose (decision 3).
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withEnvironment({ VAULT_MIGRATOR_PASSWORD: migratorPassword, VAULT_APP_PASSWORD: appPassword })
      .withCopyFilesToContainer([{ source: ROLES_SCRIPT, target: "/docker-entrypoint-initdb.d/10-vault-roles.sh", mode: 0o755 }])
      .start();
    url = container.getConnectionUri();
  } else {
    await ensureRoles(url, migratorPassword, appPassword);
  }
  project.provide("adminDatabaseUrl", url);
  project.provide("migratorPassword", migratorPassword);
  project.provide("appPassword", appPassword);
}

export async function teardown() {
  await container?.stop();
}

/** For TEST_DATABASE_URL: what 10-vault-roles.sh does for the roles, as SQL. */
async function ensureRoles(adminUrl: string, migratorPassword: string, appPassword: string) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const [role, password] of [["vault_migrator", migratorPassword], ["vault_app", appPassword]] as const) {
      const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [role]);
      if (!rowCount) await client.query(`create role ${role}`);
      const literal = (await client.query<{ q: string }>("select quote_literal($1) as q", [password])).rows[0]!.q;
      await client.query(`alter role ${role} with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password ${literal}`);
    }
  } finally {
    await client.end();
  }
}
