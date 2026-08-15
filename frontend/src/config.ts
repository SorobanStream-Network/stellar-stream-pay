import { Networks } from "@stellar/stellar-sdk";

/**
 * Runtime configuration, sourced from Vite env vars (see .env.example).
 * Values are Testnet defaults so the app runs out of the box once
 * `VITE_CONTRACT_ID` is filled in.
 */
export const CONFIG = {
  contractId: (import.meta.env.VITE_CONTRACT_ID as string) || "",
  rpcUrl:
    (import.meta.env.VITE_RPC_URL as string) ||
    "https://soroban-testnet.stellar.org",
  networkPassphrase:
    (import.meta.env.VITE_NETWORK_PASSPHRASE as string) || Networks.TESTNET,
  backendUrl:
    (import.meta.env.VITE_BACKEND_URL as string) || "http://localhost:4000",
  /** Classic-account balance lookups for pre-flight gas/trustline checks. */
  horizonUrl:
    (import.meta.env.VITE_HORIZON_URL as string) ||
    "https://horizon-testnet.stellar.org",
  /**
   * Coarse XLM floor (in XLM) that pre-flight requires for Soroban fees.
   * The real cost comes from the transaction simulation (`minResourceFee` +
   * inclusion fee); this is only a cheap "obviously broke" gate so users are
   * warned before the wallet dialog. Override with VITE_MIN_GAS_XLM.
   */
  minGasXlm: Number(import.meta.env.VITE_MIN_GAS_XLM ?? 1),
};
