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
 */
async function invoke(
  source: string,
  method: string,
  args: xdr.ScVal[],
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

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
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
 * Invoke `create_stream(...)` on behalf of the connected sender. `amount` is
 * a decimal string of the token's *base units* (e.g. stroops for XLM/SAC).
 */
export async function createStream(params: CreateStreamParams): Promise<string> {
  const { sender, receiver, token, amount, durationSeconds } = params;
  return invoke(sender, "create_stream", [
    new Address(sender).toScVal(),
    new Address(receiver).toScVal(),
    new Address(token).toScVal(),
    nativeToScVal(BigInt(amount), { type: "i128" }),
    nativeToScVal(durationSeconds, { type: "u64" }),
  ], () => preflightCreateStream(params));
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
