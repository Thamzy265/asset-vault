import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function sh(cmd: string, args: string[]) {
  return run(cmd, args, { cwd: repo }).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );
}

describe("no secrets in the repo (tester, abuse case: read secrets from the repo)", () => {
  it.each([".env", ".env.local", ".env.production", "apps/web/.env", "packages/db/.env.local"])(
    "git ignores %s",
    async (file) => {
      const result = await sh("git", ["check-ignore", "--quiet", file]);
      expect(result.code).toBe(0);
    },
  );

  it(".env.example is not ignored (so it stays in the repo)", async () => {
    expect((await sh("git", ["check-ignore", "--quiet", ".env.example"])).code).toBe(1);
  });

  it("no tracked file is a real .env", async () => {
    const { stdout } = await sh("git", ["ls-files"]);
    const envFiles = stdout.split("\n").filter((f) => /(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith(".env.example"));
    expect(envFiles).toEqual([]);
  });

  it(".env.example holds placeholders only", () => {
    const lines = readFileSync(path.join(repo, ".env.example"), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.startsWith("#"));
    const vars = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    // Empty, so a copied .env.example can never start a stack with a published password
    // (Compose's ${...:?} refuses empty). Reviewer L4; decision 3 adds the two role passwords.
    for (const name of ["POSTGRES_PASSWORD", "VAULT_MIGRATOR_PASSWORD", "VAULT_APP_PASSWORD"]) expect(vars[name], name).toBe("");
    expect(Object.keys(vars).sort()).toEqual(["POSTGRES_DB", "POSTGRES_PASSWORD", "POSTGRES_USER", "VAULT_APP_PASSWORD", "VAULT_MIGRATOR_PASSWORD", "WEB_PORT"]);
    for (const [key, value] of Object.entries(vars)) {
      expect(value, key).not.toMatch(/:\/\/.*@/); // no URL with credentials
      expect(value, key).not.toMatch(/^[A-Za-z0-9+/_-]{24,}$/); // no long token-like value
    }
  });

  it("the passwords in a local .env (if any) appear in no tracked file", async () => {
    const envPath = path.join(repo, ".env");
    if (!existsSync(envPath)) return;
    const text = readFileSync(envPath, "utf8");
    for (const name of ["POSTGRES_PASSWORD", "VAULT_MIGRATOR_PASSWORD", "VAULT_APP_PASSWORD"]) {
      const password = new RegExp(`^${name}=(.+)$`, "m").exec(text)?.[1]?.trim();
      if (!password || password === "change-me" || password.length < 8) continue;
      const result = await sh("git", ["grep", "-F", "-l", "--", password]);
      expect(result.code, name).toBe(1); // 1 = no match
      expect(result.stdout).toBe("");
    }
  });

  describe("secretlint catches a planted fake secret (temporary file, removed afterwards)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vault-secretlint-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const config = path.join(repo, ".secretlintrc.json");

    // Built at run time so this test file itself never contains a secret-shaped string.
    // (secretlint deliberately ignores the documented AWS "EXAMPLE" keys, so use random ones.)
    const awsKeyId = "AKIA" + "ZNWQ7P3KDLMT5XRJ";
    // Hex, not base64 (F-M1.1-1): secretlint's AWS secret pattern ends in `\b`, so a
    // random base64 secret ending in "/" or "+" (about 1 run in 32) was not flagged.
    const awsSecret = randomBytes(20).toString("hex");
    const ghToken = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

    it("flags an AWS key pair", async () => {
      const file = path.join(dir, "planted-aws.txt");
      writeFileSync(file, `aws_access_key_id = ${awsKeyId}\naws_secret_access_key = ${awsSecret}\n`);
      const result = await sh("pnpm", ["exec", "secretlint", "--secretlintrc", config, file]);
      expect(result.code).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/AWS|secret/i);
    });

    it("flags a GitHub token", async () => {
      const file = path.join(dir, "planted-gh.txt");
      writeFileSync(file, `token: ${ghToken}\n`);
      const result = await sh("pnpm", ["exec", "secretlint", "--secretlintrc", config, file]);
      expect(result.code).not.toBe(0);
    });

    it("flags a private key block", async () => {
      const file = path.join(dir, "planted-key.pem");
      // A throwaway key generated now, never stored anywhere but this temp file.
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
      writeFileSync(file, privateKey.export({ type: "pkcs1", format: "pem" }));
      const result = await sh("pnpm", ["exec", "secretlint", "--secretlintrc", config, file]);
      expect(result.code).not.toBe(0);
    });

    it("flags a connection string with an inline password", async () => {
      const file = path.join(dir, "planted-url.txt");
      writeFileSync(file, `DATABASE_URL=postgres://vault:${randomBytes(9).toString("hex")}@db.internal:5432/vault\n`);
      const result = await sh("pnpm", ["exec", "secretlint", "--secretlintrc", config, file]);
      expect(result.code).not.toBe(0);
    });

    it("passes a clean file (so the failures above are about the secret, not the setup)", async () => {
      const file = path.join(dir, "clean.txt");
      writeFileSync(file, "DATABASE_URL=${DATABASE_URL}\nPOSTGRES_PASSWORD=change-me\nhello world\n");
      const result = await sh("pnpm", ["exec", "secretlint", "--secretlintrc", config, file]);
      expect(result.code).toBe(0);
    });
  });

  it(".secretlintignore does not exempt source, config or docs", () => {
    const ignored = readFileSync(path.join(repo, ".secretlintignore"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    for (const dangerous of ["apps", "packages", "docs", "e2e", "test", "*.ts", "*.md", "docker-compose.yml", ".env.example", "**/*"]) {
      expect(ignored).not.toContain(dangerous);
      expect(ignored).not.toContain(`${dangerous}/`);
    }
  });
});
