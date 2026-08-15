/**
 * Wallet and transaction error decoding for the StellarStream-Pay SDK layer.
 *
 * Raw Soroban failures reach the UI as opaque strings like
 * `HostError: Error(Contract, #6)` or `AssembleTransactionError: ...`.
 * This module normalizes every failure mode we can produce — contract
 * `panic_with_error!` codes, host/system errors, simulation errors, RPC
 * transport errors, and Freighter rejections — into a single
 * {@link decodeSorobanError} function that returns a clean, actionable
 * message the UI can show verbatim.
 */

/** Error thrown for wallet and transaction failures that should be surfaced to
 * the user (installation missing, access denied, rejected/failed transaction). */
export class WalletError extends Error {}

/**
 * Error thrown by the pre-flight layer when a transaction is NOT started
 * because a cheap check failed first (missing wallet, no gas, no trustline,
 * insufficient token balance). Carries a stable machine-readable `code`.
 */
export class PreflightError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PreflightError";
    this.code = code;
  }
}

/**
 * `stream-core` contract error codes (`Error` enum in contracts/core/src/lib.rs)
 * mapped to human-readable messages. Keep in sync with the contract; code 12
 * was removed from the contract and is intentionally absent.
 */
export const STREAM_CORE_ERRORS: Readonly<Record<number, string>> = {
  1: "You are not authorized to perform this action on this stream.",
  2: "Stream not found — the id is wrong, or the entry was archived.",
  3: "This stream has already been cancelled.",
  4: "There is nothing to withdraw yet — no amount has vested so far.",
  5: "The amount must be greater than zero.",
  6: "The duration must be greater than zero.",
  7: "The sender and receiver must be different accounts.",
  8: "The token transfer did not deliver the exact amount (fee-on-transfer or non-conforming token).",
  9: "Stream id overflow — the contract has issued too many streams.",
  10: "New stream creation is paused by the contract admin. Existing streams are unaffected.",
  11: "The stream contract has not been initialized.",
  13: "A split stream needs at least one receiver.",
  14: "The receivers and amounts lists must have the same length.",
  15: "The same receiver appears more than once in this split stream.",
  16: "Split group not found — the id is wrong, or the entry was archived.",
  17: "Split amount overflow — the total is too large.",
  18: "Invalid allocation — weights must be positive and sum to the full total.",
  19: "Too many receivers in one split stream (the limit is 32).",
  20: "Too many stream ids in one bump_many call (the limit is 32). Chunk the batch and retry.",
};

/** Soroban host errors that have a stable, recognizable message fragment. */
const HOST_ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/insufficient.*balance|balance.*insufficient/i,
    "Insufficient balance to complete this transaction."],
  [/insufficient.*fee|fee.*insufficient|resource.*fee|insufficient resources/i,
    "Not enough XLM to cover the transaction's resource fees. Top up the account with XLM."],
  [/trustline|op_no_trust|no trust/i,
    "Missing asset trustline — the account must add a trustline to this token before it can send or receive it."],
  [/archiv|ttl.*expir|expired.*entry|entry.*expired/i,
    "A required ledger entry has expired (TTL). Re-submit to trigger restoration, or run a keeper `bump`/`bump_instance` first."],
  [/not.*found|does not exist/i,
    "The account or ledger entry does not exist on this network. Fund the account with XLM first."],
  [/auth.*required|require.*auth|authorization.*required/i,
    "This transaction requires authorization this account cannot provide. Switch to the correct wallet account and try again."],
  [/contract.*(not.*(found|initialized)|missing)/i,
    "The stream contract could not be reached — check VITE_CONTRACT_ID and that the contract is deployed on this network."],
];

/** Maps `sendTransaction` / `getTransaction` status strings to user messages. */
const TX_STATUS_MESSAGES: Readonly<Record<string, string>> = {
  tx_bad_auth:
    "The transaction was rejected: the required signature/authorization is missing or incorrect.",
  tx_failed:
    "The transaction failed on-chain — check your token balance, the asset trustline, and that the stream is still active.",
  tx_insufficient_fee:
    "The transaction fee was too low for the network's current requirements.",
  tx_insufficient_balance:
    "The source account does not have enough XLM to cover the transaction fees.",
  tx_too_late:
    "The transaction expired before it could be confirmed — please try again.",
  tx_duplicate: "This transaction was already submitted.",
  tx_missing_operation: "The transaction contains no operations.",
  tx_bad_seq: "The transaction sequence number is stale — refresh and retry.",
  tx_internal_error: "The network reported an internal error while processing the transaction.",
};

/** Extracts a stream-core contract error code from any error-shaped value. */
const CONTRACT_ERROR_RE = /Error\(Contract,\s*#(\d+)\)/;

/**
 * Recursively collect every string carried by an unknown error value:
 * `message` / `error` / `result` / `data` fields, nested causes, and the
 * object itself. Simulation errors are nested objects (`{ error: string }`),
 * HostErrors nest causes, and Freighter returns `{ error }` shapes.
 */
function collectErrorStrings(value: unknown, out: string[], seen: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return;
  }
  if (value instanceof Error) {
    collectErrorStrings(value.message, out, seen);
    // `Error.cause` needs ES2022 lib; the object walk below covers it on
    // targets that include it, so skip it here to keep ES2020 compatibility.
    return;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["message", "error", "result", "data", "statusText", "stack"]) {
      collectErrorStrings(obj[key], out, seen);
    }
  }
}

/** Extract the stream-core contract error code, or `null` if not a contract error. */
export function extractContractErrorCode(error: unknown): number | null {
  const strings: string[] = [];
  collectErrorStrings(error, strings, new Set());
  for (const s of strings) {
    const match = CONTRACT_ERROR_RE.exec(s);
    if (match) return Number(match[1]);
  }
  return null;
}

/** Human message for a stream-core contract error, or `null` if not one. */
export function contractErrorToMessage(error: unknown): string | null {
  const code = extractContractErrorCode(error);
  if (code === null) return null;
  const mapped = STREAM_CORE_ERRORS[code];
  return mapped
    ? `${mapped} (stream-core error #${code})`
    : `The stream contract returned an unknown error (code #${code}).`;
}

/** Human message for a `sendTransaction`/`getTransaction` status string. */
export function decodeTransactionStatus(status: string): string {
  return (
    TX_STATUS_MESSAGES[status] ??
    `The network rejected the transaction (${status}).`
  );
}

/**
 * Decode any error this app can produce into a single human-readable message.
 *
 * Order of preference:
 *  1. Errors we already constructed (WalletError / PreflightError) pass through.
 *  2. stream-core contract error codes → mapped message.
 *  3. Recognizable host/system conditions (balance, fees, trustlines, TTL).
 *  4. Freighter-specific rejections.
 *  5. The cleanest raw string available, or a generic fallback.
 */
export function decodeSorobanError(error: unknown): string {
  if (error instanceof WalletError || error instanceof PreflightError) {
    return error.message;
  }

  const contractMessage = contractErrorToMessage(error);
  if (contractMessage) return contractMessage;

  const strings: string[] = [];
  collectErrorStrings(error, strings, new Set());
  const joined = strings.join(" ");

  for (const [pattern, message] of HOST_ERROR_PATTERNS) {
    if (pattern.test(joined)) return message;
  }

  if (/freighter|extension/i.test(joined) && /reject|denied|declined|refused/i.test(joined)) {
    return "The transaction was rejected in Freighter.";
  }
  if (/reject|denied|declined/i.test(joined)) {
    return "The transaction was rejected — no changes were made.";
  }
  if (/network|fetch|socket|timeout|timed out|ECONN|axios|rpc/i.test(joined)) {
    return "Could not reach the Stellar network — check your connection and try again.";
  }

  const clean = strings
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "Error")
    .sort((a, b) => a.length - b.length)[0];

  if (clean) return clean;
  return "An unexpected error occurred. Please try again.";
}
