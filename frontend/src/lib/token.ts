/**
 * Token metadata (symbol + decimals) read from the token contract itself.
 *
 * Both SAC-wrapped assets and SEP-41 tokens implement `symbol()` and
 * `decimals()`, so a simulation is enough — no extra indexer or hardcoded
 * registry. Results are cached per process because metadata is immutable.
 *
 * If the probe fails (wrong contract id, archived token, unfunded source
 * account) we fall back to 7 decimals and a shortened contract id, so the UI
 * still renders instead of blocking on a view call.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import { CONFIG } from "../config";
import { short } from "./format";
import { rpcServer } from "./stellar/rpc";

export type TokenMeta = {
  address: string;
  symbol: string;
  decimals: number;
  /** False when the metadata could not be read (fallback values are in use). */
  resolved: boolean;
};

const cache = new Map<string, TokenMeta>();

/** Simulate a no-argument view function on `token` and return its value. */
async function readView(token: string, method: string, source?: string) {
  const server = rpcServer();
  // Simulation needs a source account; prefer the connected wallet, and fall
  // back to a throwaway key so a connected-but-unfunded flow still tries.
  const account = source
    ? await server.getAccount(source)
    : new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");
  const contract = new Contract(token);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(contract.call(method))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (Api.isSimulationError(sim) || !sim.result?.retval) {
    throw new Error(sim && "error" in sim ? String(sim.error) : `no ${method}()`);
  }
  return scValToNative(sim.result.retval);
}

/** Symbol + decimals for a token contract, cached. Never throws. */
export async function getTokenMeta(token: string, source?: string): Promise<TokenMeta> {
  const cached = cache.get(token);
  if (cached) return cached;

  const fallback: TokenMeta = {
    address: token,
    symbol: short(token),
    decimals: 7,
    resolved: false,
  };

  let meta = fallback;
  try {
    const symbol = await readView(token, "symbol", source);
    const decimals = await readView(token, "decimals", source);
    const dp = Number(decimals);
    meta = {
      address: token,
      symbol: String(symbol) || fallback.symbol,
      decimals: Number.isInteger(dp) && dp >= 0 && dp <= 18 ? dp : 7,
      resolved: true,
    };
  } catch {
    // Metadata is cosmetic: fall back rather than fail the whole render.
    meta = fallback;
  }

  // Only cache successes, so a transient RPC failure is retried later.
  if (meta.resolved) cache.set(token, meta);
  return meta;
}

/** Test/regression helper. */
export function clearTokenMetaCache(): void {
  cache.clear();
}

/** Encode an address argument (kept here so callers need one import). */
export const addressScVal = (address: string) => new Address(address).toScVal();

/** Encode an i128 amount argument. */
export const amountScVal = (amount: bigint) => nativeToScVal(amount, { type: "i128" });
