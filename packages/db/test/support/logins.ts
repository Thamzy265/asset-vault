// Test-only access to the admin commands (pnpm user:create / user:deactivate), for app tests
// that need a login. Apps themselves never create logins.
export { createLogin, deactivateLogin } from "../../src/auth/logins.ts";
