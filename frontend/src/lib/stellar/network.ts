/**
 * Network-mismatch detection.
 *
 * Two independent things can disagree with `VITE_NETWORK_PASSPHRASE`:
 *   - the RPC endpoint the app talks to (e.g. pointing at Mainnet while built
 *     for Testnet), and
 *   - the wallet's selected network (signing for a different chain).
 *
 * Either mismatch produces transactions that fail in confusing ways, so the UI
 * checks both up front and explains the fix.
 */
import { CONFIG } from "../../config";
import { rpcServer } from "./rpc";
import { getWalletNetwork } from "./wallet";

export type NetworkStatus = {
  /** Passphrase reported by the RPC endpoint (null if it could not be read). */
  rpcPassphrase: string | null;
  /** Passphrase the connected wallet reports (null if unavailable). */
  walletPassphrase: string | null;
  /** True when RPC and app config disagree. */
  rpcMismatch: boolean;
  /** True when the wallet and app config disagree. */
  walletMismatch: boolean;
  /** Human explanation, or null when everything agrees. */
  message: string | null;
};

/** Short label for a passphrase (`Test SDF Network ; September 2015` → `Testnet`). */
export function networkLabel(passphrase: string | null): string {
  if (!passphrase) return "unknown network";
  if (/test/i.test(passphrase)) return "Testnet";
  if (/public|main/i.test(passphrase)) return "Mainnet";
  if (/future/i.test(passphrase)) return "Futurenet";
  if (/standalone|local/i.test(passphrase)) return "Local network";
  return passphrase.slice(0, 24);
}

/** Compare the RPC endpoint and wallet against the configured network. */
export async function checkNetwork(): Promise<NetworkStatus> {
  let rpcPassphrase: string | null = null;
  try {
    const net = await rpcServer().getNetwork();
    rpcPassphrase = net.passphrase || null;
  } catch {
    rpcPassphrase = null;
  }
  const walletPassphrase = await getWalletNetwork();

  const rpcMismatch = !!rpcPassphrase && rpcPassphrase !== CONFIG.networkPassphrase;
  const walletMismatch =
    !!walletPassphrase && walletPassphrase !== CONFIG.networkPassphrase;

  let message: string | null = null;
  if (rpcMismatch) {
    message =
      `This app is configured for ${networkLabel(CONFIG.networkPassphrase)}, but VITE_RPC_URL ` +
      `answers for ${networkLabel(rpcPassphrase)}. Point VITE_RPC_URL at the matching network.`;
  } else if (walletMismatch) {
    message =
      `Your wallet is on ${networkLabel(walletPassphrase)}, but this app targets ` +
      `${networkLabel(CONFIG.networkPassphrase)}. Switch networks in your wallet before signing.`;
  }

  return { rpcPassphrase, walletPassphrase, rpcMismatch, walletMismatch, message };
}
