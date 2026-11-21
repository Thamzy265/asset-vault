import { randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
    migratorPassword: string;
    appPassword: string;
  }
}

export type FreshDatabase = {
  /** As vault_migrator, the database owner (like the migrate service): migrations and raw test setup. */
  url: string;
  /** As vault_app (like web and worker): only what migration 0004 grants. */
  appUrl: string;
  /** As the server's superuser, for the few checks that need one. */
  adminUrl: string;
  drop: () => Promise<void>;
};

/**
 * Creates an empty, uniquely named database owned by vault_migrator, as the
 * init script does for the Compose database (decision 3).
 */
export async function freshDatabase(): Promise<FreshDatabase> {
  const serverUrl = inject("adminDatabaseUrl");
  const name = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} OWNER vault_migrator`);
  await admin.end();
  const as = (user?: { name: string; password: string }) => {
    const url = new URL(serverUrl);
    url.pathname = `/${name}`;
    if (user) {
      url.username = user.name;
      url.password = user.password;
    }
    return url.toString();
  };
  return {
    url: as({ name: "vault_migrator", password: inject("migratorPassword") }),
    appUrl: as({ name: "vault_app", password: inject("appPassword") }),
    adminUrl: as(),
    drop: async () => {
      const c = new pg.Client({ connectionString: serverUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
