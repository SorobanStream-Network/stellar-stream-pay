import { groupDigits, short } from "../../lib/format";
import type { Stream } from "../../types";
import { Button } from "../ui/Button";
import { Meter } from "../ui/Meter";
import { Tag } from "../ui/Tag";

/**
 * A single stream row: metadata, vesting meter, and (when applicable) the
 * withdraw/cancel actions for the connected wallet.
 */
export function StreamCard({
  stream,
  walletAddress,
  busyId,
  cancellingId,
  onWithdraw,
  onCancel,
}: {
  stream: Stream;
  walletAddress: string;
  busyId: number | null;
  cancellingId: number | null;
  onWithdraw: (stream: Stream) => void;
  onCancel: (stream: Stream) => void;
}) {
  const outgoing = stream.sender === walletAddress;
  // A cancelled stream is still claimable by the receiver for the portion
  // that vested before cancellation.
  const canWithdraw =
    stream.receiver === walletAddress && BigInt(stream.withdrawable) > 0n;
  // Senders may cancel an active stream and reclaim the unvested remainder.
  const canCancel = stream.sender === walletAddress && !stream.cancelled;

  return (
    <li className={`card ${stream.cancelled ? "cancelled" : ""}`}>
      <div className="card-head">
        <span className="mono">Stream #{stream.id}</span>
        <Tag variant={outgoing ? "out" : "in"}>
          {outgoing ? "Sending" : "Receiving"}
        </Tag>
      </div>
      <div className="row">
        <span className="muted">Token</span>
        <span className="mono" title={stream.token}>
          {short(stream.token)}
        </span>
      </div>
      <div className="row">
        <span className="muted">Total</span>
        <span>{groupDigits(stream.total_amount)}</span>
      </div>
      <div className="row">
        <span className="muted">Accrued</span>
        <span>{groupDigits(stream.accrued)}</span>
      </div>
      <div className="row">
        <span className="muted">Withdrawable</span>
        <span>{groupDigits(stream.withdrawable)}</span>
      </div>
      <Meter progress={stream.progress} />
      <div className="row">
        <span className="muted">
          {stream.cancelled
            ? "Cancelled"
            : `${Math.round(stream.progress * 100)}% vested`}
        </span>
        <span className="row-actions">
          {canWithdraw && (
            <Button
              size="small"
              onClick={() => onWithdraw(stream)}
              disabled={busyId === stream.id}
            >
              {busyId === stream.id ? "Withdrawing…" : "Withdraw"}
            </Button>
          )}
          {canCancel && (
            <Button
              variant="secondary"
              size="small"
              onClick={() => onCancel(stream)}
              disabled={cancellingId === stream.id}
            >
              {cancellingId === stream.id ? "Cancelling…" : "Cancel"}
            </Button>
          )}
        </span>
      </div>
    </li>
  );
}
