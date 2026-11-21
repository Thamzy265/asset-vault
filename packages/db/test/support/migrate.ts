// Test-only access to the migrations entry point (decision 9). App tests may
// import packages/db/test/support/*, never packages/db/src (eslint.config.mjs).
export { migrateDown, migrateUp } from "../../src/migrate.ts";
export { migrations } from "../../src/migrations/index.ts";
