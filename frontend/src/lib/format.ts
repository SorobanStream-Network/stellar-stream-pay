/**
 * Group thousands for readability without converting BigInt to Number.
 * e.g. `groupDigits("1000000000")` → `"1,000,000,000"`.
 */
export function groupDigits(s: string): string {
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  return (neg ? "-" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format a unix-seconds timestamp (as the API sends it) for display, e.g.
 * `formatWhen("1767225600")` → `"Jan 1, 12:00 AM"`. Returns an em dash when
 * the value is not a number.
 */
export function formatWhen(unixSeconds: string): string {
  const ms = Number(unixSeconds) * 1000;
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Shorten a Stellar address for display: `GBVZ…ABCD`. */
export function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
