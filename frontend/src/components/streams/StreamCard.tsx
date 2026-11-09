import { useTokenMeta } from "../../hooks/useTokenMeta";
import { accruedAt, progressAt, toSeconds, withdrawableAt } from "../../lib/accrual";
import { formatUnits, formatWhen, short } from "../../lib/format";
import type { Stream } from "../../types";
import { Button } from "../ui/Button";
import { Meter } from "../ui/Meter";
import { Tag } from "../ui/Tag";

/**
 * A single stream row: metadata, **locally ticking** vesting figures, and the
 * withdraw/cancel actions for the connected wallet.
 *
 * `accrued`/`withdrawable` are recomputed from the on-chain schedule every
 * second (`now` from `useNow`) instead of only when the backend poll lands, so
 * the number visibly climbs. The API's value is used as a floor: if the local
 * clock is behind the ledger, the settled amount still shows correctly.
 */
export function StreamCard({
  stream,
  walletAddress,
  now,
  busyId,
  cancellingId,
  onWithdraw,
  onCancel,
}: {
  stream: Stream;
  walletAddress: string;
  now: number;
  busyId: number | null;
  cancellingId: number | null;
  onWithdraw: (stream: Stream) => void;
  onCancel: (stream: Stream) => void;
}) {
  const meta = useTokenMeta(stream.token, walletAddress);
  const decimals = meta.data?.decimals ?? 7;
  const symbol = meta.data?.symbol ?? "";

  const schedule = {
    total: BigInt(stream.total_amount),
    start: toSeconds(stream.start_time),
    end: toSeconds(stream.end_time),
    cliff: toSeconds(stream.cliff_time),
  };
  const withdrawn = BigInt(stream.withdrawn);

  // Cancelled streams are settled on-chain: show the frozen figures the indexer
  // recorded. Active streams tick locally from start/end/cliff.
  const localAccrued = stream.cancelled
    ? BigInt(stream.accrued)
    : accruedAt(schedule, now);
  const accrued = localAccrued > withdrawn ? localAccrued : withdrawn;
  const withdrawable = stream.cancelled
    ? 0n
    : withdrawableAt(schedule, withdrawn, now);
  const progress = stream.cancelled ? stream.progress : progressAt(schedule, now);

  const cliffSeconds = Number(stream.cliff_time);
  const hasCliff =
    Number.isFinite(cliffSeconds) && cliffSeconds > Number(stream.start_time);
  const locked = hasCliff && !stream.cancelled && now < cliffSeconds;

  const outgoing = stream.sender === walletAddress;
  const canWithdraw = stream.receiver === walletAddress && withdrawable > 0n;
  const canCancel = stream.sender === walletAddress && !stream.cancelled;

  const money = (value: bigint) =>
    `${formatUnits(value, decimals)}${symbol ? ` ${symbol}` : ""}`;

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
          {symbol || short(stream.token)}
        </span>
      </div>
      <div className="row">
        <span className="muted">Total</span>
        <span>{money(schedule.total)}</span>
      </div>
      <div className="row">
        <span className="muted">Accrued</span>
        <span>{money(accrued)}</span>
      </div>
      <div className="row">
        <span className="muted">Withdrawable</span>
        <span>{money(withdrawable)}</span>
      </div>
      {hasCliff && (
        <div className="row">
          <span className="muted">Cliff</span>
          <span>
            {locked ? `Locked until ${formatWhen(cliffSeconds)}` : formatWhen(cliffSeconds)}
          </span>
        </div>
      )}
      <div className="row">
        <span className="muted">Ends</span>
        <span>{formatWhen(stream.end_time)}</span>
      </div>
      <Meter progress={progress} />
      <div className="row">
        <span className="muted">
          {stream.cancelled
            ? "Cancelled"
            : locked
              ? "Locked until the cliff"
              : `${Math.round(progress * 100)}% vested`}
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
