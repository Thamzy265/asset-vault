/**
 * The current data rules that live code checks (review L6). Migrations keep
 * their own literal copies and are frozen once merged, so a rule change here
 * needs a new migration that changes the constraint to match;
 * test/live-rules.test.ts compares these with the constraints on a migrated
 * database.
 */

/** Record visibility (design note M1.2). */
export const VISIBILITIES = ["family", "private"] as const;

/** Every audit action the log accepts (design note M1.2). */
export const AUDIT_ACTIONS = [
  "view",
  "create",
  "update",
  "delete",
  "sign_in",
  "sign_in_failed",
  "sign_out",
  "2fa_enrolled",
  "2fa_failed",
  "password_changed",
  "backup_code_used",
] as const;

/** The audit actions that may carry an ip_prefix (design note M1.2, decision 4). */
export const IP_PREFIX_ACTIONS = ["sign_in", "sign_in_failed", "2fa_failed", "backup_code_used"] as const;

/**
 * Character classes for display names (design note M1.2, decision 6), as
 * inclusive code point ranges. names.test.ts checks each one against
 * Unicode's own property.
 */
export type CodePointRange = readonly [number, number];
/** Unicode White_Space: trimmed from both ends. */
export const WHITE_SPACE: readonly CodePointRange[] = [
  [0x09, 0x0d], [0x20, 0x20], [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a],
  [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000],
];
/** Unicode Default_Ignorable_Code_Point: zero-width and other characters that render as nothing. */
export const INVISIBLE_CHARACTERS: readonly CodePointRange[] = [
  [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfff8], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff],
];
/** Unicode Cc. */
export const CONTROL_CHARACTERS: readonly CodePointRange[] = [
  [0x00, 0x1f], [0x7f, 0x9f],
];
/** Bidi embeddings, overrides (U+202A-U+202E) and isolates (U+2066-U+2069). */
export const BIDI_OVERRIDES_AND_ISOLATES: readonly CodePointRange[] = [
  [0x202a, 0x202e], [0x2066, 0x2069],
];
export const DISPLAY_NAME_MAX_CODE_POINTS = 100;
/** Relationship (review L1): trimmed, 0-50 code points, no control or bidi override/isolate characters. */
export const RELATIONSHIP_MAX_CODE_POINTS = 50;
