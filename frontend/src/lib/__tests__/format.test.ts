import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatUnits,
  fromDateTimeLocal,
  groupDigits,
  parseUnits,
  toDateTimeLocal,
} from "../format";

describe("formatUnits", () => {
  it("renders base units with the token's decimals", () => {
    expect(formatUnits("12345678", 7)).toBe("1.2345678");
    expect(formatUnits("10000000", 7)).toBe("1");
    expect(formatUnits("1500000000", 6)).toBe("1,500");
    expect(formatUnits(0n, 7)).toBe("0");
    expect(formatUnits("1", 7)).toBe("0.0000001");
    expect(formatUnits("-2500000", 6)).toBe("-2.5");
  });

  it("handles zero-decimal tokens", () => {
    expect(formatUnits("1234", 0)).toBe("1,234");
  });

  it("stays exact for values beyond Number.MAX_SAFE_INTEGER", () => {
    expect(formatUnits("123456789012345678901", 0)).toBe("123,456,789,012,345,678,901");
  });
});

describe("parseUnits", () => {
  it("round-trips with formatUnits", () => {
    for (const [human, decimals] of [
      ["1.5", 7],
      ["0.0000001", 7],
      ["1,000", 2],
      ["42", 0],
    ] as const) {
      if (human.includes(",")) continue; // separators are display-only
      expect(formatUnits(parseUnits(human, decimals), decimals)).toBe(human);
    }
  });

  it("rejects more decimals than the token supports", () => {
    expect(() => parseUnits("1.12345678", 7)).toThrow(/7 decimal places/);
    expect(() => parseUnits("1.5", 0)).toThrow(/no decimal places/);
  });

  it("rejects empty, negative, and malformed input", () => {
    for (const bad of ["", ".", "-1", "1e5", "abc", "1.2.3"]) {
      expect(() => parseUnits(bad, 7)).toThrow();
    }
  });

  it("treats a leading dot as a fraction", () => {
    expect(parseUnits(".5", 1)).toBe(5n);
  });
});

describe("groupDigits", () => {
  it("groups thousands and keeps the sign", () => {
    expect(groupDigits("1000")).toBe("1,000");
    expect(groupDigits("-1234567")).toBe("-1,234,567");
    expect(groupDigits("999")).toBe("999");
  });
});

describe("formatDuration", () => {
  it("formats whole-second durations in at most two units", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(3_600)).toBe("1h");
    expect(formatDuration(90_000)).toBe("1d 1h");
    expect(formatDuration(604_800)).toBe("7d");
  });
});

describe("datetime-local conversion", () => {
  it("round-trips a timestamp to the minute in local time", () => {
    const unix = 1_767_225_600; // 2026-01-01T00:00:00Z
    expect(fromDateTimeLocal(toDateTimeLocal(unix))).toBe(unix);
  });

  it("rejects an invalid value", () => {
    expect(() => fromDateTimeLocal("not-a-date")).toThrow(/valid date/);
  });
});
