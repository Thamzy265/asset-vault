import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/*/test/**/*.test.ts"],
    // Database tests start a throwaway Postgres container once per run.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    passWithNoTests: true,
    globalSetup: ["packages/db/test/support/global-setup.ts"],
  },
});
