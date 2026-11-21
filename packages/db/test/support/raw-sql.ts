import pg from "pg";

/**
 * Test-only raw SQL for checking database state from app tests, which may not
 * import pg themselves (eslint no-restricted-imports in apps/*). Opens and
 * closes one connection per call.
 */
export async function rawQuery<R extends Record<string, unknown>>(url: string, text: string): Promise<R[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<R>(text)).rows;
  } finally {
    await client.end();
  }
}
