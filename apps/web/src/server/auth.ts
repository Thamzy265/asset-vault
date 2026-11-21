import { createAuthService, loadAuthConfig, log, type AuthService } from "@vault/db";
import { getDb } from "./db.ts";

const globalForAuth = globalThis as unknown as { vaultAuth?: AuthService };

/** One sign-in service per server process (M1.3), on the shared pool. */
export function getAuth(): AuthService {
  globalForAuth.vaultAuth ??= createAuthService(getDb(), loadAuthConfig(process.env), { log });
  return globalForAuth.vaultAuth;
}
