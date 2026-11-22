import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.ts";

describe("next.config", () => {
  it("turns the image optimizer off, so /_next/image is not a public endpoint (M1.3 T8)", () => {
    expect(nextConfig.images?.unoptimized).toBe(true);
  });
});
