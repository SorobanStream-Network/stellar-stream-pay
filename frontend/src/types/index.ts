/**
 * Shared domain types for the StellarStream-Pay SDK layer and React shell.
 *
 * These are framework-agnostic: the `lib/` layer and any future integrator can
 * import them without pulling in React.
 */

/** A payment stream as decorated by the backend `/api/stream/:address` endpoint. */
export type Stream = {
  id: number;
  sender: string;
  receiver: string;
  token: string;
  total_amount: string;
  withdrawn: string;
  accrued: string;
  withdrawable: string;
  start_time: string;
  end_time: string;
  /** Unix seconds at which pre-cliff accrual unlocks; equals `start_time` when
   * the stream has no cliff. Nothing is withdrawable before it. */
  cliff_time: string;
  cancelled: boolean;
  progress: number;
};

/**
 * Arguments for creating a stream on-chain.
 *
 * With neither `startDelaySeconds` nor `cliffSeconds` set this invokes
 * `create_stream` (start now, no cliff); otherwise it invokes
 * `create_stream_scheduled`.
 */
export type CreateStreamParams = {
  /** G... public key of the sender (also the transaction source). */
  sender: string;
  /** G... public key of the recipient. */
  receiver: string;
  /** C... contract id of the SAC-wrapped asset or SEP-41 token to stream. */
  token: string;
  /** Amount in the token's base units (e.g. stroops for XLM/SAC), as a string. */
  amount: string;
  /** Stream duration in seconds. */
  durationSeconds: number;
  /**
   * Optional delay, in seconds from when the transaction is **built**, before
   * the stream starts. The SDK resolves it to the absolute `start_time` the
   * contract takes right before assembling the transaction, so time spent in
   * pre-flight and the wallet dialog doesn't eat into it. Must be > 0; omit it
   * (or pass 0) to start now.
   */
  startDelaySeconds?: number;
  /**
   * Optional cliff in seconds after the start. Nothing is withdrawable before
   * `start_time + cliffSeconds`; the schedule still runs from `start_time`, so
   * the pre-cliff portion unlocks at once. Must not exceed the duration.
   */
  cliffSeconds?: number;
};
