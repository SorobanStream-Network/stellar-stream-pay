import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import type { Server } from "@stellar/stellar-sdk/rpc";
import { signTransaction } from "@stellar/freighter-api";
import { CONFIG } from "../../config";
import { decodeSorobanError, decodeTransactionStatus, WalletError } from "./errors";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Simulate + assemble a transaction, throwing a {@link WalletError} with a
 * decoded, human-readable message when the simulation fails. Simulation runs
 * BEFORE the wallet dialog, so missing trustlines, insufficient balances, and
 * authorization problems surface here as clear messages instead of a cryptic
 * wallet rejection.
 */
export async function prepareTransaction(
  server: Server,
  tx: Transaction,
): Promise<Transaction> {
  try {
    return await server.prepareTransaction(tx);
  } catch (err) {
    throw new WalletError(decodeSorobanError(err));
  }
}

/**
 * Sign an already-prepared transaction with Freighter, submit it to the RPC,
 * and poll until it reaches a terminal state. Returns the tx hash.
 *
 * Every failure point — Freighter rejection, network rejection, on-chain
 * failure — is decoded into a friendly message before being thrown.
 */
export async function signAndSubmit(
  server: Server,
  tx: Transaction,
): Promise<string> {
  const prepared = await prepareTransaction(server, tx);

  const signed = (await signTransaction(prepared.toXDR(), {
    networkPassphrase: CONFIG.networkPassphrase,
  })) as { signedTxXdr?: string; error?: unknown };

  if (signed.error || !signed.signedTxXdr) {
    throw new WalletError(
      decodeSorobanError(signed.error) || "Freighter refused to sign.",
    );
  }

  const signedTx = TransactionBuilder.fromXDR(
    signed.signedTxXdr,
    CONFIG.networkPassphrase,
  ) as Transaction;

  const sent = await server.sendTransaction(signedTx);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new WalletError(
      `Transaction rejected by the network: ${decodeTransactionStatus(sent.status)}`,
    );
  }

  let status = await server.getTransaction(sent.hash);
  while (status.status === "NOT_FOUND") {
    await sleep(1000);
    status = await server.getTransaction(sent.hash);
  }
  if (status.status !== "SUCCESS") {
    throw new WalletError(
      `Transaction failed: ${decodeTransactionStatus(status.status)} (${sent.hash})`,
    );
  }
  return sent.hash;
}
