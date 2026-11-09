import { describe, expect, it } from "vitest";
import { accruedAt, progressAt, toSeconds, withdrawableAt } from "../accrual";

const schedule = { total: 1_000n, start: 100n, end: 200n };

describe("accruedAt", () => {
  it("is zero before the start and until the first second elapses", () => {
    expect(accruedAt(schedule, 0)).toBe(0n);
    expect(accruedAt(schedule, 100)).toBe(0n);
  });

  it("interpolates linearly and floors", () => {
    expect(accruedAt(schedule, 150)).toBe(500n);
    expect(accruedAt({ total: 100n, start: 0n, end: 3n }, 1)).toBe(33n);
  });

  it("is exactly total at and after the end", () => {
    expect(accruedAt(schedule, 200)).toBe(1_000n);
    expect(accruedAt(schedule, 10_000)).toBe(1_000n);
  });

  it("never exceeds the total and never decreases over time", () => {
    let previous = 0n;
    for (let now = 0; now <= 260; now += 1) {
      const accrued = accruedAt(schedule, now);
      expect(accrued).toBeGreaterThanOrEqual(0n);
      expect(accrued).toBeLessThanOrEqual(schedule.total);
      expect(accrued).toBeGreaterThanOrEqual(previous);
      previous = accrued;
    }
  });

  it("treats a zero-length term as fully vested once it starts", () => {
    expect(accruedAt({ total: 500n, start: 10n, end: 10n }, 0)).toBe(0n);
    expect(accruedAt({ total: 500n, start: 10n, end: 10n }, 10)).toBe(500n);
  });
});

describe("cliffs", () => {
  const cliffed = { ...schedule, cliff: 150n };

  it("gates accrual instead of re-basing it", () => {
    expect(accruedAt(cliffed, 120)).toBe(0n);
    expect(accruedAt(cliffed, 149)).toBe(0n);
    // At the cliff the whole pre-cliff portion unlocks at once (50% here).
    expect(accruedAt(cliffed, 150)).toBe(500n);
    expect(accruedAt(cliffed, 175)).toBe(750n);
  });

  it("reports progress as zero while locked", () => {
    expect(progressAt(cliffed, 120)).toBe(0);
    expect(progressAt(cliffed, 150)).toBe(0.5);
  });
});

describe("withdrawableAt", () => {
  it("subtracts what was already withdrawn and floors at zero", () => {
    expect(withdrawableAt(schedule, 200n, 150)).toBe(300n);
    expect(withdrawableAt(schedule, 500n, 150)).toBe(0n);
    expect(withdrawableAt(schedule, 1_000n, 999)).toBe(0n);
  });
});

describe("toSeconds", () => {
  it("accepts the API's string times and bigints", () => {
    expect(toSeconds("1700000000")).toBe(1_700_000_000n);
    expect(toSeconds(42)).toBe(42n);
    expect(toSeconds(7n)).toBe(7n);
    expect(toSeconds("nonsense", 9n)).toBe(9n);
  });
});
