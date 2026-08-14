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
  cancelled: boolean;
  progress: number;
};

/** Arguments for invoking `create_stream` on the on-chain `stream-core` contract. */
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
};
