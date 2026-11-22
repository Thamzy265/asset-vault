import { createAuthService, loadAuthConfig, log, type AuthService } from "@vault/db";
import { getDb } from "./db.ts";

let local: AuthService | undefined;

/**
 * One sign-in service per server bundle (M1.3), on that bundle's pool, in every environment. Unlike the
 * database handle it is never shared through globalThis: the service holds the set of Viewers the
 * session module minted, and a Viewer minted by one bundle's @vault/db must never be accepted by
 * another's (reviewer C2). In development a hot reload builds a new service, which only costs a new
 * auth object on the same pooled handle.
 */
export function getAuth(): AuthService {
  local ??= createAuthService(getDb(), loadAuthConfig(process.env), { log });
  return local;
}
