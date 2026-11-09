import { useQuery } from "@tanstack/react-query";
import { getTokenMeta } from "../lib/token";

/**
 * Token symbol/decimals for a contract id. Cached forever by TanStack Query
 * (metadata is immutable) and in `lib/token.ts` per process.
 */
export function useTokenMeta(token?: string, source?: string) {
  return useQuery({
    queryKey: ["token-meta", token],
    queryFn: () => getTokenMeta(token as string, source),
    enabled: !!token,
    staleTime: Infinity,
    retry: false,
  });
}
