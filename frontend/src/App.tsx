import { useQuery } from "@tanstack/react-query";
import { useCancel } from "./hooks/mutations/useCancel";
import { useCreateStream } from "./hooks/mutations/useCreateStream";
import { useWithdraw } from "./hooks/mutations/useWithdraw";
import { useNow } from "./hooks/useNow";
import { useStreams } from "./hooks/queries/useStreams";
import { checkNetwork } from "./lib/stellar/network";
import { useUiStore } from "./state/ui";
import { useWalletStore } from "./state/wallet";
import { Topbar } from "./components/layout/Topbar";
import {
  CreateStreamForm,
  type CreateStreamDraft,
} from "./components/streams/CreateStreamForm";
import { StreamList } from "./components/streams/StreamList";
import { Banner } from "./components/ui/Banner";

export default function App() {
  const address = useWalletStore((s) => s.address);
  const connecting = useWalletStore((s) => s.connecting);
  const connect = useWalletStore((s) => s.connect);

  const error = useUiStore((s) => s.error);
  const notice = useUiStore((s) => s.notice);

  const streamsQuery = useStreams(address ?? undefined);
  const createMutation = useCreateStream();
  const withdrawMutation = useWithdraw();
  const cancelMutation = useCancel();

  // One clock for the whole dashboard: stream cards recompute their accrual
  // every second from start/end/cliff instead of waiting for the next poll.
  const now = useNow(1000);

  // Guard against pointing the app at the wrong chain (RPC or wallet).
  const networkQuery = useQuery({
    queryKey: ["network-check"],
    queryFn: checkNetwork,
    enabled: !!address,
    refetchInterval: 60_000,
    retry: false,
  });

  const streams = streamsQuery.data ?? [];
  const streamError = streamsQuery.error
    ? streamsQuery.error instanceof Error
      ? streamsQuery.error.message
      : String(streamsQuery.error)
    : null;

  const withdrawingId = withdrawMutation.isPending
    ? (withdrawMutation.variables?.streamId ?? null)
    : null;
  const cancellingId = cancelMutation.isPending
    ? (cancelMutation.variables?.streamId ?? null)
    : null;

  /** Resolves `true` so the form resets, or `false` to keep the user's input. */
  const handleCreate = async (draft: CreateStreamDraft): Promise<boolean> => {
    if (!address) return false;
    try {
      await createMutation.mutateAsync({ sender: address, ...draft });
      return true;
    } catch {
      return false;
    }
  };

  return (
    <div className="app">
      <Topbar
        walletAddress={address}
        connecting={connecting}
        loadingStreams={streamsQuery.isLoading}
        onConnect={connect}
        onRefresh={() => streamsQuery.refetch()}
      />

      <main>
        {networkQuery.data?.message && (
          <Banner variant="error">{networkQuery.data.message}</Banner>
        )}
        {error && <Banner variant="error">{error}</Banner>}
        {streamError && <Banner variant="error">{streamError}</Banner>}
        {notice && <Banner variant="success">{notice}</Banner>}

        {!address && (
          <section className="hero">
            <h2>Stream salaries, unlocks, and grants — continuously.</h2>
            <p>
              Connect a Stellar wallet (Freighter, Albedo, xBull, Lobstr, Hana
              and more) to view your streams and withdraw the amount that has
              vested so far.
            </p>
          </section>
        )}

        {address && (
          <>
            <CreateStreamForm
              creating={createMutation.isPending}
              walletAddress={address}
              onSubmit={handleCreate}
            />
            <StreamList
              streams={streams}
              walletAddress={address}
              now={now}
              loading={streamsQuery.isLoading}
              busyId={withdrawingId}
              cancellingId={cancellingId}
              onWithdraw={(stream) =>
                withdrawMutation.mutate({
                  receiver: address,
                  streamId: stream.id,
                })
              }
              onCancel={(stream) =>
                cancelMutation.mutate({
                  caller: address,
                  streamId: stream.id,
                })
              }
            />
          </>
        )}
      </main>
    </div>
  );
}
