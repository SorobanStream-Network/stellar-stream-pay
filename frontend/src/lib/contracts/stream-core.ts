import {
  Address,
  BASE_FEE,
  Contract,
  nativeToScVal,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { CONFIG } from "../../config";
import type { CreateStreamParams } from "../../types";
import { decodeSorobanError, WalletError } from "../stellar/errors";
import {
  preflightCancel,
  preflightCreateStream,
  preflightWithdraw,
} from "../stellar/preflight";
import { rpcServer } from "../stellar/rpc";
import { signAndSubmit } from "../stellar/tx";

function requireContractId(): string {
  if (!CONFIG.contractId) throw new WalletError("VITE_CONTRACT_ID is not set.");
  return CONFIG.contractId;
}

/**
 * Build, pre-flight, simulate, sign (via Freighter), and submit a single
 * contract invocation.
 *
 * `preflight` runs BEFORE the wallet dialog so users see why a transaction
 * would fail (no gas, no trustline, no balance) instead of a cryptic rejection.
 * The simulation inside `signAndSubmit` then catches anything the static
 * checks can't see (stream state, exact fees, auth entries).
 *
 * `source` is the account that authorizes the call — the receiver for
 * `withdraw`, either party for `cancel`, the sender for `create_stream`, and
 * any account for the permissionless TTL keepers.
 *
 * `args` may be a thunk: it is evaluated as late as possible (after
 * pre-flight and the account fetch, right before the transaction is built) so
 * anything time-dependent in the calldata — like a scheduled `start_time` — is
 * anchored to the moment of building rather than to the call site.
 */
async function invoke(
  source: string,
  method: string,
  args: xdr.ScVal[] | (() => xdr.ScVal[]),
  preflight?: () => Promise<void>,
): Promise<string> {
  if (preflight) await preflight();

  const server = rpcServer();
  let sourceAccount;
  try {
    sourceAccount = await server.getAccount(source);
  } catch (err) {
    // Pre-flight already asserted the account exists; this only fires on a
    // between-check race (e.g. an unfunded keeper account). Decode it so the
    // UI never shows a raw RPC error.
    throw new WalletError(decodeSorobanError(err));
  }
  const contract = new Contract(requireContractId());
  // Resolved here — the latest possible moment before building — so a delayed
  // schedule is measured from build time, not from when the user clicked.
  const scvArgs = typeof args === "function" ? args() : args;

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(contract.call(method, ...scvArgs))
    .setTimeout(30)
    .build();

  return signAndSubmit(server, tx);
}

/**
 * Invoke `withdraw(stream_id)` for the connected receiver. The receiver is
 * the transaction source account, so they authorize the call themselves.
 */
export async function withdrawStream(
  receiver: string,
  streamId: number,
): Promise<string> {
  return invoke(receiver, "withdraw", [
    new Address(receiver).toScVal(),
    nativeToScVal(streamId, { type: "u64" }),
  ], () => preflightWithdraw(receiver));
}

/**
 * Invoke `cancel(stream_id)` on behalf of the connected sender or receiver.
 * Cancelling fully settles the stream: the vested remainder is paid to the
 * receiver and the unvested remainder is refunded to the sender in one call.
 */
export async function cancelStream(
  caller: string,
  streamId: number,
): Promise<string> {
  return invoke(caller, "cancel", [
    new Address(caller).toScVal(),
    nativeToScVal(streamId, { type: "u64" }),
  ], () => preflightCancel(caller));
}

/**
 * Encode a Soroban `Option<u64>`: `None` is `ScVal::Void` and `Some(v)` is
 * `ScVal::U64`. `nativeToScVal` has no Option mapping, so this is built by hand.
 */
function optionalU64(value: number | undefined): xdr.ScVal {
  if (value == null) return xdr.ScVal.scvVoid();
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(String(Math.trunc(value))));
}

/**
 * Resolve a relative start delay to an absolute unix timestamp. Called from a
 * lazily-built args thunk, i.e. at transaction build time.
 *
 * No safety margin is added here: the contract accepts a `start_time` up to
 * `START_TIME_GRACE_SECONDS` (two minutes) behind the executing ledger, which
 * covers the few ledgers a transaction can wait between build and inclusion, so
 * the delay the user asked for is preserved exactly.
 */
function resolveStartTime(delaySeconds: number): number {
  return Math.floor(Date.now() / 1000) + Math.floor(delaySeconds);
}

/**
 * Create a stream on behalf of the connected sender. `amount` is a decimal
 * string of the token's *base units* (e.g. stroops for XLM/SAC).
 *
 * With neither `startDelaySeconds` nor `cliffSeconds` this sends the v1
 * `create_stream` call (start now, no cliff). When either is supplied it sends
 * `create_stream_scheduled`, which takes the same arguments plus two
 * `Option<u64>`s. A cliff gates the unlock without re-basing the schedule:
 * nothing is withdrawable before `start_time + cliffSeconds`, and from then on
 * the ordinary start-to-end line applies.
 *
 * The delay is resolved to `start_time` when the transaction is built (see
 * {@link invoke}), so pre-flight checks, the simulation round-trip, and the
 * Freighter dialog don't consume the delay the user asked for.
 */
export async function createStream(params: CreateStreamParams): Promise<string> {
  const {
    sender,
    receiver,
    token,
    amount,
    durationSeconds,
    startDelaySeconds,
    cliffSeconds,
  } = params;
  const delay =
    startDelaySeconds != null && startDelaySeconds > 0 ? startDelaySeconds : undefined;
  const scheduled = delay != null || cliffSeconds != null;

  const buildArgs = (startTime: number | undefined): xdr.ScVal[] => {
    const args: xdr.ScVal[] = [
      new Address(sender).toScVal(),
      new Address(receiver).toScVal(),
      new Address(token).toScVal(),
      nativeToScVal(BigInt(amount), { type: "i128" }),
      nativeToScVal(durationSeconds, { type: "u64" }),
    ];
    if (scheduled) args.push(optionalU64(startTime), optionalU64(cliffSeconds));
    return args;
  };

  return invoke(
    sender,
    scheduled ? "create_stream_scheduled" : "create_stream",
    scheduled
      ? // Thunk: anchor `start_time` at build time, not at call time.
        () => buildArgs(delay != null ? resolveStartTime(delay) : undefined)
      : buildArgs(undefined),
    () => preflightCreateStream(params),
  );
}

/**
 * Permissionless TTL keeper: extend a stream entry's lease so a long-running
 * stream is never archived mid-term. Anyone may call it — it changes nothing
 * but TTLs — so a relayer/keeper bot can keep every stream alive. Pre-flight
 * is skipped: the call is permissionless and only needs gas.
 */
export async function bumpStreamTtl(
  source: string,
  streamId: number,
): Promise<string> {
  return invoke(source, "bump", [
    nativeToScVal(streamId, { type: "u64" }),
  ]);
}

/**
 * Permissionless TTL keeper, batched: re-arm several streams' leases in ONE
 * transaction so a large fleet pays one tx per pass instead of one per
 * stream. Same semantics as `bumpStreamTtl`, atomic on-chain — a missing
 * stream id reverts the whole batch. Keep batches within the contract's
 * `MAX_BUMP_BATCH` (32) or the call reverts with `BatchTooLarge` (#20).
 */
export async function bumpStreamsTtl(
  source: string,
  streamIds: number[],
): Promise<string> {
  return invoke(source, "bump_many", [
    nativeToScVal(streamIds, { type: streamIds.map(() => "u64") }),
  ]);
}

/**
 * Permissionless TTL keeper: extend the contract instance + Wasm code lease to
 * the network maximum. Needed when a contract is idle (no streams to `bump`),
 * because an archived instance can never be invoked again — stranding funds.
 */
export async function bumpContractTtl(source: string): Promise<string> {
  return invoke(source, "bump_instance", []);
}
