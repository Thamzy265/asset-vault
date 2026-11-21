import {
  BIDI_OVERRIDES_AND_ISOLATES,
  CONTROL_CHARACTERS,
  DISPLAY_NAME_MAX_CODE_POINTS,
  INVISIBLE_CHARACTERS,
  WHITE_SPACE,
  type CodePointRange,
} from "./rules.ts";

/** A RegExp bracket body for the ranges (`u` flag). */
function jsClass(...sets: ReadonlyArray<readonly CodePointRange[]>): string {
  const esc = (cp: number) => `\\u{${cp.toString(16)}}`;
  return sets
    .flat()
    .map(([from, to]) => (from === to ? esc(from) : `${esc(from)}-${esc(to)}`))
    .join("");
}

const SPACE = new RegExp(`^[${jsClass(WHITE_SPACE)}]$`, "u");
const FORBIDDEN = new RegExp(`[${jsClass(CONTROL_CHARACTERS, BIDI_OVERRIDES_AND_ISOLATES)}]`, "u");
const VISIBLE = new RegExp(`[^${jsClass(WHITE_SPACE, INVISIBLE_CHARACTERS)}]`, "u");

/**
 * Display name rules (design note M1.2, decision 6). Trims Unicode whitespace
 * from both ends, then returns null (refused) when the name is empty or blank
 * (only whitespace or zero-width characters), holds a control, bidi override
 * or isolate character or a lone surrogate, or is longer than 100 code
 * points. The database check (migration 0002) matches; test/live-rules.test.ts checks it.
 */
export function normaliseDisplayName(raw: string): string | null {
  if (!raw.isWellFormed()) return null;
  const name = trimSpace(raw);
  if (FORBIDDEN.test(name) || !VISIBLE.test(name)) return null;
  const codePoints = [...name].length;
  return codePoints >= 1 && codePoints <= DISPLAY_NAME_MAX_CODE_POINTS ? name : null;
}

/** Trims WHITE_SPACE from both ends in one linear pass (a `[ ]+$` regex backtracks on long inner runs). */
function trimSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && SPACE.test(text[start]!)) start++;
  while (end > start && SPACE.test(text[end - 1]!)) end--;
  return text.slice(start, end);
}
