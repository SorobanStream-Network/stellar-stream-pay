import { useCallback, useState } from "react";
import { getStreams } from "./lib/api/indexer";
import {
  cancelStream,
  createStream,
  withdrawStream,
} from "./lib/contracts/stream-core";
import { connectWallet } from "./lib/stellar/wallet";
import type { Stream } from "./types";
import { Topbar } from "./components/layout/Topbar";
import {
  CreateStreamForm,
  type CreateStreamFormValues,
} from "./components/streams/CreateStreamForm";
import { StreamList } from "./components/streams/StreamList";
import { Banner } from "./components/ui/Banner";

export default function App() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [loadingStreams, setLoadingStreams] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStreams = useCallback(async (addr: string) => {
    setLoadingStreams(true);
    try {
      setStreams(await getStreams(addr));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingStreams(false);
    }
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const addr = await connectWallet();
      setWalletAddress(addr);
      await loadStreams(addr);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  const handleWithdraw = async (s: Stream) => {
    if (!walletAddress) return;
    setBusyId(s.id);
    setError(null);
    setNotice(null);
    try {
      const hash = await withdrawStream(walletAddress, s.id);
      setNotice(`Withdrawal submitted: ${hash.slice(0, 14)}…`);
      await loadStreams(walletAddress);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleCancel = async (s: Stream) => {
    if (!walletAddress) return;
    setCancellingId(s.id);
    setError(null);
    setNotice(null);
    try {
      const hash = await cancelStream(walletAddress, s.id);
      setNotice(`Stream cancelled: ${hash.slice(0, 14)}…`);
      await loadStreams(walletAddress);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancellingId(null);
    }
  };

  /**
   * Returns `true` on success (so the form can reset) or `false` after
   * surfacing the error (so the form keeps the user's input for retry).
   */
  const handleCreate = async (values: CreateStreamFormValues): Promise<boolean> => {
    if (!walletAddress) return false;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const hash = await createStream({
        sender: walletAddress,
        receiver: values.receiver.trim(),
        token: values.token.trim(),
        amount: values.amount.trim(),
        durationSeconds: Number(values.duration),
      });
      setNotice(`Stream creation submitted: ${hash.slice(0, 14)}…`);
      await loadStreams(walletAddress);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="app">
      <Topbar
        walletAddress={walletAddress}
        connecting={connecting}
        loadingStreams={loadingStreams}
        onConnect={handleConnect}
        onRefresh={() => loadStreams(walletAddress!)}
      />

      <main>
        {error && <Banner variant="error">{error}</Banner>}
        {notice && <Banner variant="success">{notice}</Banner>}

        {!walletAddress && (
          <section className="hero">
            <h2>Stream salaries, unlocks, and grants — continuously.</h2>
            <p>
              Connect your Freighter wallet to view your streams and withdraw
              the amount that has vested so far.
            </p>
          </section>
        )}

        {walletAddress && (
          <>
            <CreateStreamForm creating={creating} onSubmit={handleCreate} />
            <StreamList
              streams={streams}
              walletAddress={walletAddress}
              loading={loadingStreams}
              busyId={busyId}
              cancellingId={cancellingId}
              onWithdraw={handleWithdraw}
              onCancel={handleCancel}
            />
          </>
        )}
      </main>
    </div>
  );
}
