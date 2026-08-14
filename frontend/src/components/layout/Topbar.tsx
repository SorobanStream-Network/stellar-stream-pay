import { short } from "../../lib/format";
import { Button } from "../ui/Button";

/**
 * App header: brand on the left, wallet pill + refresh (when connected) or a
 * connect button on the right.
 */
export function Topbar({
  walletAddress,
  connecting,
  loadingStreams,
  onConnect,
  onRefresh,
}: {
  walletAddress: string | null;
  connecting: boolean;
  loadingStreams: boolean;
  onConnect: () => void;
  onRefresh: () => void;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <h1>StellarStream&nbsp;·&nbsp;Pay</h1>
        <p>Continuous streaming payroll on Stellar</p>
      </div>
      {walletAddress ? (
        <div className="wallet">
          <span className="pill" title={walletAddress}>
            {short(walletAddress)}
          </span>
          <Button variant="secondary" onClick={onRefresh}>
            {loadingStreams ? "Loading…" : "Refresh"}
          </Button>
        </div>
      ) : (
        <Button onClick={onConnect} disabled={connecting}>
          {connecting ? "Connecting…" : "Connect Freighter"}
        </Button>
      )}
    </header>
  );
}
