import { describe, expect, it } from "vitest";
import { DatabaseUnavailableError, waitForDatabase } from "../src/wait-for-database.ts";

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

describe("waitForDatabase", () => {
  it("returns at once when the database answers", async () => {
    const clock = fakeClock();
    let calls = 0;
    await waitForDatabase(async () => { calls++; }, clock);
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("retries with growing, capped delays until the database answers", async () => {
    const clock = fakeClock();
    let calls = 0;
    await waitForDatabase(async () => {
      calls++;
      if (calls < 6) throw new Error("ECONNREFUSED");
    }, { ...clock, initialDelayMs: 500, maxDelayMs: 4000, jitter: () => 1 });
    expect(calls).toBe(6);
    expect(clock.sleeps).toEqual([500, 1000, 2000, 4000, 4000]);
  });

  it("gives up after the time limit (default 60 s) with a clear error", async () => {
    const clock = fakeClock();
    const attempt = waitForDatabase(async () => { throw new Error("ECONNREFUSED"); }, clock);
    await expect(attempt).rejects.toBeInstanceOf(DatabaseUnavailableError);
    await expect(waitForDatabase(async () => { throw new Error("x"); }, fakeClock())).rejects.toThrow(/60 s/);
    const waited = clock.sleeps.reduce((a, b) => a + b, 0);
    expect(waited).toBeLessThanOrEqual(60_000);
    expect(waited).toBeGreaterThan(55_000);
  });

  it("reports each failed attempt without the connection string", async () => {
    const clock = fakeClock();
    const seen: Array<{ attempt: number; delayMs: number }> = [];
    let calls = 0;
    await waitForDatabase(async () => {
      if (++calls < 3) throw new Error("down");
    }, { ...clock, jitter: () => 1, onRetry: (info) => seen.push({ attempt: info.attempt, delayMs: info.delayMs }) });
    expect(seen).toEqual([{ attempt: 1, delayMs: 500 }, { attempt: 2, delayMs: 1000 }]);
  });
});
