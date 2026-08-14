import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import type { Server } from "@stellar/stellar-sdk/rpc";
import { signTransaction } from "@stellar/freighter-api";
import { CONFIG } from "../../config";
import { WalletError } from "./errors";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Simulate + assemble a transaction, ask Freighter to sign it, submit it to
 * the RPC, and poll until it reaches a terminal state. Returns the tx hash.
 *
 * `prepareTransaction` = simulateTransaction + assembleTransaction: fills the
 * Soroban footprint and the required authorization entries for
 * `receiver.require_auth()` / token transfers.
 */
export async function signAndSubmit(
  server: Server,
  tx: Transaction,
): Promise<string> {
  const prepared = await server.prepareTransaction(tx);

  const signed = (await signTransaction(prepared.toXDR(), {
    networkPassphrase: CONFIG.networkPassphrase,
  })) as { signedTxXdr?: string; error?: unknown };

  if (signed.error || !signed.signedTxXdr) {
    throw new WalletError(String(signed.error ?? "Freighter refused to sign."));
  }

  const signedTx = TransactionBuilder.fromXDR(
    signed.signedTxXdr,
    CONFIG.networkPassphrase,
  ) as Transaction;

  const sent = await server.sendTransaction(signedTx);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new WalletError(`Transaction rejected by the network: ${sent.status}`);
  }

  let status = await server.getTransaction(sent.hash);
  while (status.status === "NOT_FOUND") {
    await sleep(1000);
    status = await server.getTransaction(sent.hash);
  }
  if (status.status !== "SUCCESS") {
    throw new WalletError(`Transaction failed (${status.status}): ${sent.hash}`);
  }
  return sent.hash;
}
