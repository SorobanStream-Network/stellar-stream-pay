import {
  Address,
  BASE_FEE,
  Contract,
  nativeToScVal,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import { isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";
import { CONFIG } from "../config";

export class WalletError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rpcServer(): Server {
  return new Server(CONFIG.rpcUrl, {
    allowHttp: CONFIG.rpcUrl.startsWith("http://"),
  });
}

/** Connect to Freighter and return the active public key (G...). */
export async function connectWallet(): Promise<string> {
  const installed = (await isConnected()) as { isConnected?: boolean };
  if (!installed.isConnected) {
    throw new WalletError(
      "Freighter is not installed. Please install the Freighter browser extension.",
    );
  }
  const res = (await requestAccess()) as { address?: string; error?: unknown };
  if (res.error || !res.address) {
    throw new WalletError(String(res.error ?? "Freighter access was denied."));
  }
  return res.address;
}

/**
 * Simulate + assemble a transaction, ask Freighter to sign it, submit it to
 * the RPC, and poll until it reaches a terminal state. Returns the tx hash.
 */
async function signAndSubmit(server: Server, tx: Transaction): Promise<string> {
  // prepareTransaction = simulateTransaction + assembleTransaction: fills the
  // Soroban footprint and the required authorization entries for
  // `receiver.require_auth()` / token transfers.
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

/**
 * Invoke `withdraw(stream_id)` for the connected receiver. The receiver is
 * the transaction source account, so they authorize the call themselves.
 */
export async function withdrawStream(
  receiver: string,
  streamId: number,
): Promise<string> {
  if (!CONFIG.contractId) throw new WalletError("VITE_CONTRACT_ID is not set.");
  const server = rpcServer();
  const sourceAccount = await server.getAccount(receiver);
  const contract = new Contract(CONFIG.contractId);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(
      contract.call(
        "withdraw",
        new Address(receiver).toScVal(),
        nativeToScVal(streamId, { type: "u64" }),
      ),
    )
    .setTimeout(30)
    .build();

  return signAndSubmit(server, tx);
}

/**
 * Invoke `cancel(stream_id)` on behalf of the connected sender or receiver.
 * Cancelling fully settles the stream: the vested remainder is paid to the
 * receiver and the unvested remainder is refunded to the sender in one call.
 */
export async function cancelStream(
  sender: string,
  streamId: number,
): Promise<string> {
  if (!CONFIG.contractId) throw new WalletError("VITE_CONTRACT_ID is not set.");
  const server = rpcServer();
  const sourceAccount = await server.getAccount(sender);
  const contract = new Contract(CONFIG.contractId);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(
      contract.call(
        "cancel",
        new Address(sender).toScVal(),
        nativeToScVal(streamId, { type: "u64" }),
      ),
    )
    .setTimeout(30)
    .build();

  return signAndSubmit(server, tx);
}

/**
 * Invoke `create_stream(...)` on behalf of the connected sender. `amount` is
 * a decimal string of the token's *base units* (e.g. stroops for XLM/SAC).
 */
export async function createStream(params: {
  sender: string;
  receiver: string;
  token: string; // C... contract id of the SAC-wrapped asset or SEP-41 token
  amount: string; // base units, integer
  durationSeconds: number;
}): Promise<string> {
  const { sender, receiver, token, amount, durationSeconds } = params;
  if (!CONFIG.contractId) throw new WalletError("VITE_CONTRACT_ID is not set.");
  const server = rpcServer();
  const sourceAccount = await server.getAccount(sender);
  const contract = new Contract(CONFIG.contractId);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(
      contract.call(
        "create_stream",
        new Address(sender).toScVal(),
        new Address(receiver).toScVal(),
        new Address(token).toScVal(),
        nativeToScVal(BigInt(amount), { type: "i128" }),
        nativeToScVal(durationSeconds, { type: "u64" }),
      ),
    )
    .setTimeout(30)
    .build();

  return signAndSubmit(server, tx);
}
