import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cancelStream } from "../../lib/contracts/stream-core";
import { useUiStore } from "../../state/ui";
import { streamKeys } from "../queryKeys";

/**
 * Cancel an active stream (either party). Invalidates the caller's streams
 * cache so the dashboard refetches the settled state.
 */
export function useCancel() {
  const queryClient = useQueryClient();
  const setError = useUiStore((s) => s.setError);
  const setNotice = useUiStore((s) => s.setNotice);

  return useMutation({
    mutationFn: ({ caller, streamId }: { caller: string; streamId: number }) =>
      cancelStream(caller, streamId),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: (hash) => {
      setNotice(`Stream cancelled: ${hash.slice(0, 14)}…`);
    },
    onError: (error) => {
      setError(error instanceof Error ? error.message : String(error));
    },
    onSettled: (_data, _error, { caller }) => {
      void queryClient.invalidateQueries({
        queryKey: streamKeys.byAddress(caller),
      });
    },
  });
}
