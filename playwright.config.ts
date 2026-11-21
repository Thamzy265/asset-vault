import { defineConfig, devices } from "@playwright/test";

// Runs against the Compose stack, which must already be up: `docker compose up -d --wait`.
const port = process.env.WEB_PORT ?? "3000";

export default defineConfig({
  testDir: "e2e",
  outputDir: "qa-artifacts/playwright",
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: "**/*.destructive.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Specs that stop and restart a service. They run alone, after everything
      // else, so they cannot disturb the other specs.
      name: "destructive",
      testMatch: "**/*.destructive.spec.ts",
      dependencies: ["chromium"],
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
