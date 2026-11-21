import { describe, expect, it } from "vitest";
import { HEARTBEAT_MAX_AGE_MS, isHeartbeatFresh } from "../src/healthcheck.ts";

describe("worker healthcheck", () => {
  const now = new Date("2026-11-21T10:05:00.000Z");

  it("allows a little over two missed minutes", () => {
    expect(HEARTBEAT_MAX_AGE_MS).toBe(150_000);
  });

  it("is healthy when the last heartbeat is recent", () => {
    expect(isHeartbeatFresh(new Date("2026-11-21T10:04:00.000Z"), now)).toBe(true);
  });

  it("is unhealthy when the heartbeat is too old", () => {
    expect(isHeartbeatFresh(new Date("2026-11-21T10:02:00.000Z"), now)).toBe(false);
  });

  it("is unhealthy when there has been no heartbeat yet", () => {
    expect(isHeartbeatFresh(null, now)).toBe(false);
  });
});
