import { useCancel } from "./hooks/mutations/useCancel";
import { useCreateStream } from "./hooks/mutations/useCreateStream";
import { useWithdraw } from "./hooks/mutations/useWithdraw";
import { useStreams } from "./hooks/queries/useStreams";
import { useUiStore } from "./state/ui";
import { useWalletStore } from "./state/wallet";
import { Topbar } from "./components/layout/Topbar";
import {
  CreateStreamForm,
  type CreateStreamFormValues,
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
  const handleCreate = async (
    values: CreateStreamFormValues,
  ): Promise<boolean> => {
    if (!address) return false;
    try {
      await createMutation.mutateAsync({
        sender: address,
        receiver: values.receiver.trim(),
        token: values.token.trim(),
        amount: values.amount.trim(),
        durationSeconds: Number(values.duration),
      });
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
        {error && <Banner variant="error">{error}</Banner>}
        {streamError && <Banner variant="error">{streamError}</Banner>}
        {notice && <Banner variant="success">{notice}</Banner>}

        {!address && (
          <section className="hero">
            <h2>Stream salaries, unlocks, and grants — continuously.</h2>
            <p>
              Connect your Freighter wallet to view your streams and withdraw
              the amount that has vested so far.
            </p>
          </section>
        )}

        {address && (
          <>
            <CreateStreamForm
              creating={createMutation.isPending}
              onSubmit={handleCreate}
            />
            <StreamList
              streams={streams}
              walletAddress={address}
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
