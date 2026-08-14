import { create } from "zustand";
import { connectWallet } from "../lib/stellar/wallet";
import { useUiStore } from "./ui";

/**
 * Wallet session state: the connected Freighter address and connection
 * progress. Client-only — nothing here is server cache, so it belongs in
 * Zustand rather than TanStack Query.
 */
interface WalletState {
  address: string | null;
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
}

export const useWalletStore = create<WalletState>((set) => ({
  address: null,
  connecting: false,
  connect: async () => {
    set({ connecting: true });
    useUiStore.getState().setError(null);
    try {
      const address = await connectWallet();
      set({ address, connecting: false });
    } catch (error) {
      useUiStore
        .getState()
        .setError(error instanceof Error ? error.message : String(error));
      set({ connecting: false });
    }
  },
  disconnect: () => set({ address: null }),
}));
