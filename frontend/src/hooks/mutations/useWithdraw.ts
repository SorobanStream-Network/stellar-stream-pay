import { useMutation, useQueryClient } from "@tanstack/react-query";
import { withdrawStream } from "../../lib/contracts/stream-core";
import { useUiStore } from "../../state/ui";
import { streamKeys } from "../queryKeys";

/**
 * Withdraw the accrued amount of a stream. Invalidates the receiver's streams
 * cache so the dashboard refetches the settled state.
 */
export function useWithdraw() {
  const queryClient = useQueryClient();
  const setError = useUiStore((s) => s.setError);
  const setNotice = useUiStore((s) => s.setNotice);

  return useMutation({
    mutationFn: ({
      receiver,
      streamId,
    }: {
      receiver: string;
      streamId: number;
    }) => withdrawStream(receiver, streamId),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: (hash) => {
      setNotice(`Withdrawal submitted: ${hash.slice(0, 14)}…`);
    },
    onError: (error) => {
      setError(error instanceof Error ? error.message : String(error));
    },
    onSettled: (_data, _error, { receiver }) => {
      void queryClient.invalidateQueries({
        queryKey: streamKeys.byAddress(receiver),
      });
    },
  });
}
