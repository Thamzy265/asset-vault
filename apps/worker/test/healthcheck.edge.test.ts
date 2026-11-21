import { describe, expect, it } from "vitest";
import { HEARTBEAT_MAX_AGE_MS, isHeartbeatFresh } from "../src/healthcheck.ts";

describe("worker healthcheck staleness boundary (tester)", () => {
  const now = new Date("2026-11-21T10:05:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("is healthy at exactly 150 s old", () => {
    expect(isHeartbeatFresh(ago(150_000), now)).toBe(true);
  });
  it("is healthy 1 ms inside the limit", () => {
    expect(isHeartbeatFresh(ago(149_999), now)).toBe(true);
  });
  it("is unhealthy 1 ms past the limit", () => {
    expect(isHeartbeatFresh(ago(150_001), now)).toBe(false);
  });
  it("tracks the exported constant rather than a hidden number", () => {
    expect(isHeartbeatFresh(ago(HEARTBEAT_MAX_AGE_MS), now)).toBe(true);
    expect(isHeartbeatFresh(ago(HEARTBEAT_MAX_AGE_MS + 1), now)).toBe(false);
  });
  it("treats a heartbeat from the future (clock skew) as fresh, not as an error", () => {
    expect(isHeartbeatFresh(new Date(now.getTime() + 5_000), now)).toBe(true);
  });
  it("treats an Invalid Date as unhealthy", () => {
    expect(isHeartbeatFresh(new Date("not a date"), now)).toBe(false);
  });
  it("is unhealthy for the epoch", () => {
    expect(isHeartbeatFresh(new Date(0), now)).toBe(false);
  });
  it("stays within one missed run plus margin: 60 s old is healthy, 3 missed runs (180 s) is not", () => {
    expect(isHeartbeatFresh(ago(60_000), now)).toBe(true);
    expect(isHeartbeatFresh(ago(180_000), now)).toBe(false);
  });
});
