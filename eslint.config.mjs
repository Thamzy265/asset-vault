import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import globals from "globals";
import tseslint from "typescript-eslint";

const RAW_DB_MESSAGE =
  "No raw database access outside packages/db: use @vault/db's functions and repositories (they apply the visibility check and write the audit log).";
const PG_BOSS_MESSAGE =
  "Only apps/worker/src/worker.ts may import pg-boss: its getDb().executeSql() runs any SQL as the app role with no visibility check (review L3).";
const PG_BOSS_SQL_MESSAGE =
  "No pg-boss getDb()/executeSql() in apps: they run raw SQL with no visibility check. Use @vault/db's functions and repositories (review L3).";
const LOADER_MESSAGE =
  "Apps load modules with static imports or literal import() only (no require, createRequire or node:module), so the no-raw-database rule can see every module they use.";

// Every source extension Node or Next.js loads (tester round L7).
const APP_FILES = "apps/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const APP_TESTS = "apps/*/test/**";

// Module specifiers apps may not use (case-insensitive: macOS paths are).
//  - the database drivers and any deep path into @vault/db;
//  - a URL (file:, data:, http:): it can name any file, spelled any way;
//  - a package.json "#subpath" import: it can map to any module;
//  - a relative or absolute path through node_modules (a way round the bare-name check);
//  - production code: any path through packages/ (L4, L6). Apps reach packages by name only.
//  - tests: any path through packages/ except one file in packages/db/test/support/.
const DB_DRIVERS = ["kysely", "pg", "pg-pool"];
const DB_DRIVER_SPECIFIER = String.raw`^(kysely|pg|pg-pool)(\/|$)|^@vault\/db\/`;
// pg-boss (L3): only the file that wires the queues (WORKER_FILE) may import it.
const PG_BOSS_SPECIFIER = String.raw`^pg-boss(\/|$)`;
const WORKER_FILE = "apps/worker/src/worker.ts";
const RAW_SQL_MEMBERS = "/^(getDb|executeSql)$/";
const URL_SPECIFIER = String.raw`^(?!node:)[a-z][a-z0-9+.-]*:`;
const SUBPATH_SPECIFIER = String.raw`^#`;
const NODE_MODULES_PATH = String.raw`^[.\/\\].*(^|[\/\\])node_modules([\/\\]|$)`;
const PACKAGES_PATH = String.raw`^[.\/\\].*(^|[\/\\])packages([\/\\]|$)`;
const PACKAGES_PATH_EXCEPT_TEST_SUPPORT = String.raw`^[.\/\\].*(^|[\/\\])packages([\/\\](?!db\/test\/support\/(?!\.)[\w.-]+$)|$)`;

function noRawDatabaseAccess({ testFiles, allowPgBoss = false }) {
  const pathRule = testFiles ? PACKAGES_PATH_EXCEPT_TEST_SUPPORT : PACKAGES_PATH;
  const forbidden = [DB_DRIVER_SPECIFIER, URL_SPECIFIER, SUBPATH_SPECIFIER, NODE_MODULES_PATH, pathRule];
  const pgBoss = allowPgBoss ? [] : [PG_BOSS_SPECIFIER];
  // esquery regex literal: slashes escaped, case-insensitive.
  const asSelector = (regex) => `/${regex.replaceAll("/", "\\/").replaceAll("\\\\/", "\\/")}/iu`;
  return {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          ...DB_DRIVERS.map((name) => ({ name, message: RAW_DB_MESSAGE })),
          ...["module", "node:module"].map((name) => ({ name, message: LOADER_MESSAGE })),
        ],
        patterns: [
          { group: ["kysely/*", "pg/*", "pg-pool/*", "@vault/db/*"], message: RAW_DB_MESSAGE },
          ...forbidden.map((regex) => ({ regex, message: RAW_DB_MESSAGE })),
          ...pgBoss.map((regex) => ({ regex, message: PG_BOSS_MESSAGE })),
        ],
      },
    ],
    "no-restricted-syntax": [
      "error",
      // import() is checked like a static import, and only a plain string literal can be checked (L1, L2).
      { selector: "ImportExpression[source.type!='Literal']", message: LOADER_MESSAGE },
      ...forbidden.map((regex) => ({ selector: `ImportExpression[source.value=${asSelector(regex)}]`, message: RAW_DB_MESSAGE })),
      ...pgBoss.map((regex) => ({ selector: `ImportExpression[source.value=${asSelector(regex)}]`, message: PG_BOSS_MESSAGE })),
      // pg-boss's raw SQL door (L3), however it is reached: x.getDb, x["executeSql"], { getDb } = x.
      { selector: `MemberExpression[property.name=${RAW_SQL_MEMBERS}]`, message: PG_BOSS_SQL_MESSAGE },
      { selector: `MemberExpression[property.value=${RAW_SQL_MEMBERS}]`, message: PG_BOSS_SQL_MESSAGE },
      { selector: `ObjectPattern > Property[key.name=${RAW_SQL_MEMBERS}]`, message: PG_BOSS_SQL_MESSAGE },
      { selector: `ObjectPattern > Property[key.value=${RAW_SQL_MEMBERS}]`, message: PG_BOSS_SQL_MESSAGE },
      { selector: "ImportExpression[source.value=/^(node:)?module$/]", message: LOADER_MESSAGE },
      // CommonJS loaders (L3).
      { selector: "CallExpression[callee.name='require']", message: LOADER_MESSAGE },
      { selector: "MemberExpression[property.name='require']", message: LOADER_MESSAGE },
      { selector: "MemberExpression[property.value='require']", message: LOADER_MESSAGE },
      { selector: "Identifier[name='createRequire']", message: LOADER_MESSAGE },
      { selector: "MemberExpression[property.name='getBuiltinModule']", message: LOADER_MESSAGE },
      { selector: "TSExternalModuleReference", message: LOADER_MESSAGE },
    ],
  };
}

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
    // the audit log (test/no-raw-db-access*.test.ts). A guardrail: the database
    // roles (decision 3) are the backstop.
    files: [APP_FILES],
    ignores: [APP_TESTS],
    rules: noRawDatabaseAccess({ testFiles: false }),
  },
  {
    files: [`${APP_TESTS}/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`],
    rules: noRawDatabaseAccess({ testFiles: true }),
  },
  {
    // L3: the one file that may import pg-boss (it still may not call getDb/executeSql).
    files: [WORKER_FILE],
    rules: noRawDatabaseAccess({ testFiles: false, allowPgBoss: true }),
  },
  {
    // L5: inline config comments (eslint-disable, /* eslint rule: off */) have no
    // effect in apps, so the rule above can't be switched off file by file. An
    // exception goes in this file, where review sees it. Elsewhere they still work.
    files: [APP_FILES],
    linterOptions: { noInlineConfig: true },
  },
  {
    files: ["**/*.jsx"],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
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
