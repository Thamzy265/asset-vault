import { createAuthService, loadAuthConfig, log, type AuthService } from "@vault/db";
import { getDb } from "./db.ts";

const shared = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
const globalForAuth = globalThis as unknown as { vaultAuth?: AuthService };
let local: AuthService | undefined;

/**
 * One sign-in service per server bundle (M1.3), on that bundle's pool. Kept per
 * module in production for the same reason as getDb(): a service built by one
 * bundle's @vault/db must never meet another bundle's handle or Viewer.
 */
export function getAuth(): AuthService {
  const make = () => createAuthService(getDb(), loadAuthConfig(process.env), { log });
  if (shared) {
    globalForAuth.vaultAuth ??= make();
    return globalForAuth.vaultAuth;
  }
  local ??= make();
  return local;
}
