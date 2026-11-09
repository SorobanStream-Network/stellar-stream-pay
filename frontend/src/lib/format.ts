/**
 * Display + parsing helpers for amounts, timestamps, and durations.
 *
 * Amounts are handled as decimal strings of base units (what the API returns)
 * and converted with `BigInt` — never `Number` — so 7-decimal token amounts and
 * large `i128` totals stay exact.
 */

/**
 * Group thousands for readability without converting BigInt to Number.
 * e.g. `groupDigits("1000000000")` → `"1,000,000,000"`.
 */
export function groupDigits(s: string): string {
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  return (neg ? "-" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Shorten a Stellar address for display: `GBVZ…ABCD`. */
export function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Format base units as a human decimal amount.
 * `formatUnits("12345678", 7)` → `"1.2345678"`; trailing fraction zeros are
 * dropped so whole amounts read cleanly (`"10000000"` → `"1"`).
 */
export function formatUnits(raw: string | bigint, decimals: number): string {
  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  const d = Math.max(0, Math.trunc(decimals));
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(d);
  const whole = abs / base;
  const frac = abs % base;

  const wholeStr = groupDigits(whole.toString());
  if (d === 0 || frac === 0n) return `${negative ? "-" : ""}${wholeStr}`;

  const fracStr = frac.toString().padStart(d, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${wholeStr}.${fracStr}`;
}

/**
 * Parse a human decimal amount into base units.
 * `parseUnits("1.5", 7)` → `15000000n`.
 *
 * Throws on input that is not a plain positive decimal or that carries more
 * decimal places than the token supports (silently truncating would quietly
 * change the amount the user asked to lock).
 */
export function parseUnits(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error("Enter a valid amount, e.g. 1.5");
  }
  const [whole, frac = ""] = trimmed.split(".");
  const d = Math.max(0, Math.trunc(decimals));
  if (frac.length > d) {
    throw new Error(
      d === 0 ? "This token has no decimal places" : `At most ${d} decimal places`,
    );
  }
  return BigInt((whole || "0") + frac.padEnd(d, "0"));
}

/**
 * Format a unix-seconds timestamp (as the API sends it) for display, e.g.
 * `formatWhen("1767225600")` → `"Jan 1, 12:00 AM"`. Returns an em dash when
 * the value is not a number.
 */
export function formatWhen(unixSeconds: string | number | bigint): string {
  const ms = Number(unixSeconds) * 1000;
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Human duration: `formatDuration(90_000)` → `"1d 1h"`. */
export function formatDuration(totalSeconds: number): string {
  const secs = Math.max(0, Math.floor(totalSeconds));
  if (secs === 0) return "0s";
  const units: Array<[number, string]> = [
    [86_400, "d"],
    [3_600, "h"],
    [60, "m"],
    [1, "s"],
  ];
  const parts: string[] = [];
  let rest = secs;
  for (const [size, label] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n}${label}`);
      rest -= n * size;
    }
    if (parts.length === 2) break; // two units is plenty for a label
  }
  return parts.join(" ");
}

/** Value for an `<input type="datetime-local">` from unix seconds (local tz). */
export function toDateTimeLocal(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** Unix seconds from an `<input type="datetime-local">` value. */
export function fromDateTimeLocal(value: string): number {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error("Pick a valid date and time");
  return Math.floor(ms / 1000);
}
