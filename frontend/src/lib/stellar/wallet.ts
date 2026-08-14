import { isConnected, requestAccess } from "@stellar/freighter-api";
import { WalletError } from "./errors";

/**
 * Connect to Freighter and return the active public key (G...).
 * Throws a {@link WalletError} if Freighter is missing or access is denied.
 */
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
