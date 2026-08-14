import { create } from "zustand";

/**
 * Client-side UI state: the transient error/success banners. Server data
 * (streams, balances, events) lives in TanStack Query, not here.
 */
interface UiState {
  error: string | null;
  notice: string | null;
  setError: (error: string | null) => void;
  setNotice: (notice: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  error: null,
  notice: null,
  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),
}));
