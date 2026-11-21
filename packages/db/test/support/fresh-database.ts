import { randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
  }
}

/** Creates an empty, uniquely named database and returns its URL and a drop function. */
export async function freshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const adminUrl = inject("adminDatabaseUrl");
  const name = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
