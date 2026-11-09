/**
 * Client-side accrual math.
 *
 * These are pure functions mirroring `stream-core`'s vesting formula, used to
 * tick `accrued`/`withdrawable` locally between backend polls (and to render a
 * pending withdrawal optimistically). They are deliberately dependency-free so
 * they can be unit-tested with Vitest and reused by any integrator.
 *
 * Contract semantics being mirrored:
 *   accrued(t) = 0                              if t < cliff
 *              = total × (min(t,end) − start) / (end − start)   otherwise (floored)
 * A cliff gates the unlock without re-basing the schedule, so the pre-cliff
 * portion unlocks at once when the cliff passes.
 */

export type AccrualSchedule = {
  total: bigint;
  /** Unix seconds (accepts the strings the API returns via `BigInt(...)`). */
  start: bigint;
  end: bigint;
  /** Unix seconds at which accrual unlocks; defaults to `start` (no cliff). */
  cliff?: bigint | null;
};

/** Whole seconds from a numeric/string/bigint timestamp. */
export function toSeconds(value: number | string | bigint, fallback = 0n): bigint {
  if (typeof value === "bigint") return value;
  const n = Number(value);
  return Number.isFinite(n) ? BigInt(Math.floor(n)) : fallback;
}

/**
 * Vested amount at `now` (unix seconds), clamped to `[0, total]`.
 *
 * Monotonic in `now`, never negative, and exactly `total` at/after `end` —
 * the same invariants the contract's property tests assert.
 */
export function accruedAt(schedule: AccrualSchedule, now: number | string | bigint): bigint {
  const nowSecs = toSeconds(now);
  const { total, start, end } = schedule;
  const cliff = schedule.cliff == null ? start : schedule.cliff;

  if (nowSecs < cliff) return 0n;
  // Defensive: a zero-length term (the contract rejects duration 0, so this is
  // only reachable for malformed input) is fully vested once it starts.
  if (end <= start) return nowSecs >= start ? total : 0n;
  if (nowSecs <= start) return 0n;

  const t = nowSecs < end ? nowSecs : end;
  const accrued = (total * (t - start)) / (end - start);
  return accrued > 0n ? (accrued < total ? accrued : total) : 0n;
}

/** `accrued − already withdrawn`, floored at zero. */
export function withdrawableAt(
  schedule: AccrualSchedule,
  withdrawn: bigint,
  now: number | string | bigint,
): bigint {
  const accrued = accruedAt(schedule, now);
  const delta = accrued - withdrawn;
  return delta > 0n ? delta : 0n;
}

/** Elapsed fraction of the term in `[0, 1]`; `0` until the cliff passes. */
export function progressAt(schedule: AccrualSchedule, now: number | string | bigint): number {
  const nowSecs = toSeconds(now);
  const { start, end } = schedule;
  const cliff = schedule.cliff == null ? start : schedule.cliff;
  if (end <= start) return 1;
  if (nowSecs < cliff) return 0;
  const t = nowSecs < end ? nowSecs : end;
  const elapsed = Number(t - start);
  const duration = Number(end - start);
  return Math.min(Math.max(elapsed / duration, 0), 1);
}
