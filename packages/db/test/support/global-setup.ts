import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
  }
}

// Same image as docker-compose.yml. Set TEST_DATABASE_URL to use an existing
// throwaway server instead of starting a container.
export const POSTGRES_IMAGE = "postgres:18-alpine";

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    url = container.getConnectionUri();
  }
  project.provide("adminDatabaseUrl", url);
}

export async function teardown() {
  await container?.stop();
}
