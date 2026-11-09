import { useEffect, useState } from "react";

/**
 * A clock that re-renders every `intervalMs`, in unix seconds.
 *
 * Used to tick a stream's `accrued` balance locally between backend polls: the
 * schedule is deterministic (start/end/cliff are on chain), so the client can
 * compute it exactly instead of refetching every second.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    const tick = () => setNow(Date.now() / 1000);
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
