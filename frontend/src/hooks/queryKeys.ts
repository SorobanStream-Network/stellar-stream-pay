/**
 * Centralized TanStack Query keys so the streams query and its mutations
 * invalidate the same cache entry.
 */
export const streamKeys = {
  all: ["streams"] as const,
  byAddress: (address: string) => ["streams", address] as const,
};
