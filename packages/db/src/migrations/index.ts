import type { Migration } from "kysely/migration";
import * as m0001 from "./0001_meta.ts";

/**
 * Every migration, in order. Each one exports an explicit `up` and `down`.
 * Listed statically (not read from disk) so they work the same in tests,
 * the worker image and the CLI.
 */
export const migrations: Record<string, Migration> = {
  "0001_meta": m0001,
};
