/**
 * Linear progress bar. `progress` is a ratio in `[0, 1]` (vested ÷ total).
 */
export function Meter({ progress }: { progress: number }) {
  return (
    <div className="meter">
      <div
        className="meter-fill"
        style={{ width: `${Math.round(progress * 100)}%` }}
      />
    </div>
  );
}
