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
import { WalletError } from "../stellar/errors";
import { rpcServer } from "../stellar/rpc";
import { signAndSubmit } from "../stellar/tx";

function requireContractId(): string {
  if (!CONFIG.contractId) throw new WalletError("VITE_CONTRACT_ID is not set.");
  return CONFIG.contractId;
}

/**
 * Build, sign (via Freighter), and submit a single contract invocation.
 * `source` is the account that authorizes the call — the receiver for
 * `withdraw`, either party for `cancel`, and the sender for `create_stream`.
 */
async function invoke(
  source: string,
  method: string,
  args: xdr.ScVal[],
): Promise<string> {
  const server = rpcServer();
  const sourceAccount = await server.getAccount(source);
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
  ]);
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
  ]);
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
  ]);
}
