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
