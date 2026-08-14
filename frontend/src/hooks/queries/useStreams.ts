import { useQuery } from "@tanstack/react-query";
import { getStreams } from "../../lib/api/indexer";
import { streamKeys } from "../queryKeys";

/**
 * Streams for a wallet address, with live polling so `accrued` / `progress`
 * tick up as vesting advances. Disabled until an address is connected.
 */
export function useStreams(address?: string) {
  return useQuery({
    queryKey: address ? streamKeys.byAddress(address) : streamKeys.all,
    queryFn: () => getStreams(address as string),
    enabled: !!address,
    refetchInterval: 15_000,
  });
}
