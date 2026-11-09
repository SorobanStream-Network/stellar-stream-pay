/**
 * Wallet abstraction over Stellar Wallets Kit.
 *
 * The kit gives one API for Freighter/Varial, Albedo, xBull, Rabet, Lobstr,
 * Hana, Klever, OneKey, Bitget, Fordefi, CactusLink, Dcent, Scopuly, MetaMask
 * and Ghostsig, so the app no longer assumes a single extension. Only wallets
 * that need no extra configuration are enabled (`defaultModules()`), which keeps
 * the bundle free of WalletConnect/Ledger polyfills.
 *
 * Nothing here touches a private key: the kit asks the selected wallet to sign
 * and hands back signed XDR.
 */
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { CONFIG } from "../../config";
import { decodeSorobanError, WalletError } from "./errors";

let ready = false;

/** Lazily initialise the kit (it touches the DOM, so not at import time). */
function kit(): typeof StellarWalletsKit {
  if (!ready) {
    StellarWalletsKit.init({ modules: defaultModules() });
    ready = true;
  }
  return StellarWalletsKit;
}

/**
 * Open the wallet picker and return the connected account.
 * Throws a {@link WalletError} when the user closes/cancels the modal.
 */
export async function connectWallet(): Promise<string> {
  try {
    const { address } = await kit().authModal();
    if (!address) throw new WalletError("The wallet did not return an address.");
    return address;
  } catch (err) {
    if (err instanceof WalletError) throw err;
    throw new WalletError(
      decodeSorobanError(err) || "Wallet connection was cancelled.",
    );
  }
}

/** The already-authorized address, without opening any UI (`null` if none). */
export async function getWalletAddress(): Promise<string | null> {
  try {
    const { address } = await kit().getAddress();
    return address || null;
  } catch {
    return null;
  }
}

/** Forget the selected wallet/address. */
export async function disconnectWallet(): Promise<void> {
  try {
    await kit().disconnect();
  } catch {
    // Nothing to disconnect — treat as success.
  }
}

/**
 * Sign a prepared transaction XDR. `address` pins which account must sign, so a
 * wallet switched mid-flow fails loudly instead of signing for the wrong key.
 * Returns the signed XDR.
 */
export async function signWalletTransaction(
  xdr: string,
  address?: string,
): Promise<string> {
  try {
    const signed = await kit().signTransaction(xdr, {
      networkPassphrase: CONFIG.networkPassphrase,
      address,
    });
    if (!signed.signedTxXdr) {
      throw new WalletError("The wallet returned no signed transaction.");
    }
    return signed.signedTxXdr;
  } catch (err) {
    if (err instanceof WalletError) throw err;
    throw new WalletError(decodeSorobanError(err) || "The wallet refused to sign.");
  }
}

/**
 * The wallet's active network passphrase, or `null` when the wallet cannot
 * report it (hardware/some extensions). Used for network-mismatch detection.
 */
export async function getWalletNetwork(): Promise<string | null> {
  try {
    const { networkPassphrase } = await kit().getNetwork();
    return networkPassphrase || null;
  } catch {
    return null;
  }
}
