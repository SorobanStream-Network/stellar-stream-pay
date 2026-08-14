import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createStream } from "../../lib/contracts/stream-core";
import type { CreateStreamParams } from "../../types";
import { useUiStore } from "../../state/ui";
import { streamKeys } from "../queryKeys";

/**
 * Create a stream, locking the sender's tokens in the vault. Invalidates the
 * sender's streams cache so the dashboard refetches the new stream.
 */
export function useCreateStream() {
  const queryClient = useQueryClient();
  const setError = useUiStore((s) => s.setError);
  const setNotice = useUiStore((s) => s.setNotice);

  return useMutation({
    mutationFn: (params: CreateStreamParams) => createStream(params),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: (hash) => {
      setNotice(`Stream creation submitted: ${hash.slice(0, 14)}…`);
    },
    onError: (error) => {
      setError(error instanceof Error ? error.message : String(error));
    },
    onSettled: (_data, _error, params) => {
      void queryClient.invalidateQueries({
        queryKey: streamKeys.byAddress(params.sender),
      });
    },
  });
}
