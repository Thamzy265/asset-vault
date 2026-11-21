import { describe, expect, it, vi } from "vitest";

// Review L7: `next dev` re-evaluates changed modules. The web app keeps its
// DbHandle on globalThis across reloads, so a reloaded handle.ts must still
// resolve a handle made before the reload.
describe("database handles survive a reload of handle.ts", () => {
  it("a handle from before the reload resolves to the same client after it", async () => {
    const before = await import("../src/handle.ts");
    const handle = before.openDatabase("postgres://u@127.0.0.1:1/none");
    try {
      vi.resetModules();
      const after = await import("../src/handle.ts");
      expect(after).not.toBe(before); // really a second evaluation of the module
      expect(after.kyselyOf(handle)).toBe(before.kyselyOf(handle));
    } finally {
      await before.closeDatabase(handle);
    }
  });

  it("an object that only looks like a handle is still refused", async () => {
    const { kyselyOf } = await import("../src/handle.ts");
    expect(() => kyselyOf(Object.freeze({ kind: "vault-db" }) as never)).toThrow(TypeError);
  });
});
