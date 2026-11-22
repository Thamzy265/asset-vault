import { dictionary } from "@zxcvbn-ts/language-common";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./options.ts";

/**
 * The local common-password list (design note M1.3, abuse case "I guess
 * passwords"): zxcvbn-ts's frequency list of ~49,000 passwords seen in
 * breaches, pinned in package.json. Checked locally, never sent anywhere.
 */
const COMMON = new Set(dictionary["passwords-common"].map((p) => p.toLowerCase()));

export type PasswordProblem = "password_too_short" | "password_too_long" | "password_too_common";

/** Length in characters as a person counts them (code points), like the 12-character rule says. */
export function passwordProblem(password: string): PasswordProblem | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return "password_too_short";
  if (length > PASSWORD_MAX_LENGTH) return "password_too_long";
  // Nothing a person could mean as a password: only whitespace, or one character repeated.
  if (password.trim() === "" || new Set(password).size === 1) return "password_too_common";
  if (COMMON.has(password.toLowerCase()) || COMMON.has(password.trim().toLowerCase())) return "password_too_common";
  return null;
}
