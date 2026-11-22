import { describe, expect, it } from "vitest";
import { normalisePath } from "../src/server/gate-path.ts";

// Lead decision 7 (M1.3): the default-deny gate decides on the decoded, normalised path.
describe("normalisePath", () => {
  it.each([
    ["/api/v1/me", "/api/v1/me"],
    ["/API/V1/Me", "/api/v1/me"],
    ["/api/v1%2Fme", "/api/v1/me"],
    ["/api/v1%2fme", "/api/v1/me"],
    ["/%61pi/v1/m%65", "/api/v1/me"],
    ["/api/v1%252Fme", "/api/v1/me"], // double encoded
    ["/api/v1%25252Fme", "/api/v1/me"], // triple encoded
    ["/api/v1//me", "/api/v1/me"],
    ["/api/./v1/x/../me", "/api/v1/me"],
    ["/foo/..%2fapi/v1/me", "/api/v1/me"],
    ["/foo/%2e%2e/api/v1/me", "/api/v1/me"],
    ["/api\\v1\\me", "/api/v1/me"],
    ["/api/v1/me/", "/api/v1/me"],
    ["/../../api/v1/me", "/api/v1/me"],
    ["/", "/"],
    ["", "/"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalisePath(raw)).toBe(expected);
  });

  it.each(["/%", "/api/v1/%zz", "/api/v1/%E0%A4%A", "/%c0%af", "/api/v1/me%", "/a%2", "/%25%", "/%252%"])("a path that fails to decode (%s) is null", (raw) => {
    expect(normalisePath(raw)).toBeNull();
  });

  it("a path that keeps changing however often it is decoded is refused", () => {
    expect(normalisePath(`/api/v1${"%25".repeat(8)}2Fme`)).toBeNull();
  });
});
