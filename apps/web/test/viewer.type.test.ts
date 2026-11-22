import type { Viewer } from "@vault/db";
import { describe, expect, it } from "vitest";

// M1.3 carried item (a), type level: `pnpm typecheck` fails if a plain object ever becomes
// assignable to Viewer again (each @ts-expect-error would then be unused, which tsc reports).
describe("Viewer is a branded type", () => {
  it("a plain object literal is not a Viewer", () => {
    // @ts-expect-error a hand-made object lacks the brand only the session module adds
    const admin: Viewer = { userId: "00000000-0000-4000-8000-000000000000", role: "admin", personId: null };
    expect(admin.role).toBe("admin");
  });

  it("a function can't return a hand-made Viewer either", () => {
    // @ts-expect-error same: no brand
    const make = (): Viewer => ({ userId: "u", role: "member", personId: null });
    expect(typeof make).toBe("function");
  });
});
