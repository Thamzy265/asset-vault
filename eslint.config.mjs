import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import globals from "globals";
import tseslint from "typescript-eslint";

const RAW_DB_MESSAGE =
  "No raw database access outside packages/db: use @vault/db's functions and repositories (they apply the visibility check and write the audit log).";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/next-env.d.ts",
      "qa-artifacts/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // M1.2: no raw database access outside packages/db. Apps use @vault/db's
    // functions and repositories, which apply the visibility check and write
    // the audit log (test/no-raw-db-access.test.ts).
    files: ["apps/**/*.{ts,tsx,js,mjs,cjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["kysely", "pg", "pg-pool"].map((name) => ({ name, message: RAW_DB_MESSAGE })),
          patterns: [
            { group: ["kysely/*", "pg/*", "pg-pool/*", "@vault/db/*"], message: RAW_DB_MESSAGE },
            { regex: "(^|/)packages/db/src(/|$)", message: RAW_DB_MESSAGE },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^(kysely|pg|pg-pool|@vault\\/db\\/)|packages\\/db\\/src/]",
          message: RAW_DB_MESSAGE,
        },
      ],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
    settings: { next: { rootDir: "apps/web" } },
  },
);
