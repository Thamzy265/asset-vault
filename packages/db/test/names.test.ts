import { describe, expect, it } from "vitest";
import { BIDI_OVERRIDES_AND_ISOLATES, CONTROL_CHARACTERS, INVISIBLE_CHARACTERS, WHITE_SPACE } from "../src/rules.ts";
import { normaliseDisplayName } from "../src/names.ts";

// M1.2 decision 6: names are trimmed of Unicode whitespace, then refused when
// empty, blank (only whitespace or zero-width characters), holding control,
// bidi override or isolate characters, or lone surrogates; 1-100 code points.

/** Every code point (surrogates excluded) for which `test` holds, as [first, last] ranges. */
function rangesWhere(test: (ch: string) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (!test(String.fromCodePoint(cp))) continue;
    const last = out.at(-1);
    if (last && last[1] === cp - 1) last[1] = cp;
    else out.push([cp, cp]);
  }
  return out;
}

describe("the character classes match Unicode's own properties (no typos in the ranges)", () => {
  it("WHITE_SPACE is \\p{White_Space}", () => {
    expect(WHITE_SPACE).toEqual(rangesWhere((ch) => /\p{White_Space}/u.test(ch)));
  });
  it("CONTROL_CHARACTERS is \\p{Cc}", () => {
    expect(CONTROL_CHARACTERS).toEqual(rangesWhere((ch) => /\p{Cc}/u.test(ch)));
  });
  it("INVISIBLE_CHARACTERS is \\p{Default_Ignorable_Code_Point} (zero-width and other characters that render as nothing)", () => {
    expect(INVISIBLE_CHARACTERS).toEqual(rangesWhere((ch) => /\p{Default_Ignorable_Code_Point}/u.test(ch)));
  });
  it("BIDI_OVERRIDES_AND_ISOLATES is U+202A-U+202E and U+2066-U+2069", () => {
    expect(BIDI_OVERRIDES_AND_ISOLATES).toEqual([
      [0x202a, 0x202e],
      [0x2066, 0x2069],
    ]);
  });
});

describe("normaliseDisplayName", () => {
  it.each([
    ["Jane", "Jane"],
    ["  Padded Name  ", "Padded Name"],
    ["\t\nTabbed\r\n", "Tabbed"],
    [" 　Wide ", "Wide"],
    ["José Müller-Núñez", "José Müller-Núñez"],
    ["محمد علي", "محمد علي"],
    ["Anna עברית Anna", "Anna עברית Anna"],
    ["名前　全角スペース", "名前　全角スペース"],
    ["\u{1f468}\u200d\u{1f469}\u200d\u{1f467}", "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}"], // zero-width joiners inside a visible name are fine
    ["x", "x"],
    ["a".repeat(100), "a".repeat(100)],
    [` ${"😀".repeat(100)} `, "😀".repeat(100)], // 100 code points after trimming
  ])("accepts %j as %j", (raw, expected) => {
    expect(normaliseDisplayName(raw)).toBe(expected);
  });

  it.each([
    ["empty", ""],
    ["spaces only", "   "],
    ["tab", "\t"],
    ["newline", "\n"],
    ["no-break space", " "],
    ["ideographic space", "　"],
    ["zero-width space", "​"],
    ["zero-width joiner and non-joiner", "‍‌"],
    ["word joiner and BOM", "⁠﻿"],
    ["spaces around a zero-width space", " ​ "],
    ["left-to-right mark only", "‎"],
    ["Hangul filler only", "ㅤ"],
    ["variation selector only", "️"],
    ["tab inside", "a\tb"],
    ["newline inside", "a\nb"],
    ["null byte", "Bad\u0000Name"],
    ["DEL", "a\u007fb"],
    ["C1 control (NEL inside)", "a\u0085b"],
    ["right-to-left override", "Ann‮abc"],
    ["left-to-right embedding", "‪Ann"],
    ["pop directional formatting", "Ann‬"],
    ["first strong isolate", "Ann⁨x⁩"],
    ["right-to-left isolate", "⁧Ann"],
    ["lone high surrogate", "bad\ud800name"],
    ["lone low surrogate", "bad\udc00name"],
    ["101 letters", "a".repeat(101)],
    ["101 emoji", "😀".repeat(101)],
    ["51 decomposed accents (102 code points)", "e\u0301".repeat(51)],
    ["1 MB", "x".repeat(1_000_000)],
  ])("refuses %s", (_label, raw) => {
    expect(normaliseDisplayName(raw)).toBeNull();
  });
});

it("stays fast on long inputs (no regex backtracking): 1 MB of inner spaces is refused in well under a second", () => {
  const started = performance.now();
  expect(normaliseDisplayName(`a${" ".repeat(1_000_000)}b`)).toBeNull();
  expect(normaliseDisplayName(`${" ".repeat(1_000_000)}Jane${"\u3000".repeat(1_000_000)}`)).toBe("Jane");
  expect(performance.now() - started).toBeLessThan(1_000);
});
