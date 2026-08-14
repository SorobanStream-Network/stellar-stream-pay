import type { Stream } from "../../types";
import { StreamCard } from "./StreamCard";

/**
 * Panel listing every stream for the connected wallet, with loading and empty
 * states. Delegate per-stream rendering to {@link StreamCard}.
 */
export function StreamList({
  streams,
  walletAddress,
  loading,
  busyId,
  cancellingId,
  onWithdraw,
  onCancel,
}: {
  streams: Stream[];
  walletAddress: string;
  loading: boolean;
  busyId: number | null;
  cancellingId: number | null;
  onWithdraw: (stream: Stream) => void;
  onCancel: (stream: Stream) => void;
}) {
  return (
    <section className="panel">
      <h2>Your streams</h2>
      {loading && <p className="muted">Loading streams…</p>}
      {!loading && streams.length === 0 && (
        <p className="muted">No streams found for this address yet.</p>
      )}
      <ul className="streams">
        {streams.map((stream) => (
          <StreamCard
            key={stream.id}
            stream={stream}
            walletAddress={walletAddress}
            busyId={busyId}
            cancellingId={cancellingId}
            onWithdraw={onWithdraw}
            onCancel={onCancel}
          />
        ))}
      </ul>
    </section>
  );
}
