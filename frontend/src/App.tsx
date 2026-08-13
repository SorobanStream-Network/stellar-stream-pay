import { useCallback, useState, type FormEvent } from "react";
import { CONFIG } from "./config";
import { createStream, connectWallet, withdrawStream } from "./lib/soroban";

/** Shape returned by the backend `/api/stream/:address` endpoint. */
type Stream = {
  id: number;
  sender: string;
  receiver: string;
  token: string;
  total_amount: string;
  withdrawn: string;
  accrued: string;
  withdrawable: string;
  start_time: string;
  end_time: string;
  cancelled: boolean;
  progress: number;
};

const emptyForm = { receiver: "", token: "", amount: "", duration: "" };

/** Group thousands for readability without converting BigInt to Number. */
function groupDigits(s: string): string {
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  return (neg ? "-" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

export default function App() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [loadingStreams, setLoadingStreams] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStreams = useCallback(async (addr: string) => {
    setLoadingStreams(true);
    try {
      const res = await fetch(`${CONFIG.backendUrl}/api/stream/${addr}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setStreams(data.streams ?? []);
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

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!walletAddress) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const hash = await createStream({
        sender: walletAddress,
        receiver: form.receiver.trim(),
        token: form.token.trim(),
        amount: form.amount.trim(),
        durationSeconds: Number(form.duration),
      });
      setNotice(`Stream creation submitted: ${hash.slice(0, 14)}…`);
      setForm(emptyForm);
      await loadStreams(walletAddress);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>StellarStream&nbsp;·&nbsp;Pay</h1>
          <p>Continuous streaming payroll on Stellar</p>
        </div>
        {walletAddress ? (
          <div className="wallet">
            <span className="pill" title={walletAddress}>{short(walletAddress)}</span>
            <button className="btn secondary" onClick={() => loadStreams(walletAddress)}>
              {loadingStreams ? "Loading…" : "Refresh"}
            </button>
          </div>
        ) : (
          <button className="btn primary" onClick={handleConnect} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect Freighter"}
          </button>
        )}
      </header>

      <main>
        {error && <div className="banner error">{error}</div>}
        {notice && <div className="banner success">{notice}</div>}

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
            <section className="panel">
              <h2>Create a stream</h2>
              <form className="grid" onSubmit={handleCreate}>
                <label>
                  Receiver (G…)
                  <input
                    required
                    placeholder="GBVZ…"
                    value={form.receiver}
                    onChange={(e) => setForm({ ...form, receiver: e.target.value })}
                  />
                </label>
                <label>
                  Token contract (C…)
                  <input
                    required
                    placeholder="C… (SAC-wrapped asset or SEP-41 token)"
                    value={form.token}
                    onChange={(e) => setForm({ ...form, token: e.target.value })}
                  />
                </label>
                <label>
                  Amount (base units)
                  <input
                    required
                    inputMode="numeric"
                    placeholder="1000000000"
                    value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  />
                </label>
                <label>
                  Duration (seconds)
                  <input
                    required
                    type="number"
                    min="1"
                    placeholder="2592000"
                    value={form.duration}
                    onChange={(e) => setForm({ ...form, duration: e.target.value })}
                  />
                </label>
                <button className="btn primary" type="submit" disabled={creating}>
                  {creating ? "Submitting…" : "Lock & stream"}
                </button>
              </form>
            </section>

            <section className="panel">
              <h2>Your streams</h2>
              {loadingStreams && <p className="muted">Loading streams…</p>}
              {!loadingStreams && streams.length === 0 && (
                <p className="muted">No streams found for this address yet.</p>
              )}
              <ul className="streams">
                {streams.map((s) => {
                  const outgoing = s.sender === walletAddress;
                  const canWithdraw =
                    !s.cancelled &&
                    s.receiver === walletAddress &&
                    BigInt(s.withdrawable) > 0n;
                  return (
                    <li key={s.id} className={`card ${s.cancelled ? "cancelled" : ""}`}>
                      <div className="card-head">
                        <span className="mono">Stream #{s.id}</span>
                        <span className={`tag ${outgoing ? "out" : "in"}`}>
                          {outgoing ? "Sending" : "Receiving"}
                        </span>
                      </div>
                      <div className="row">
                        <span className="muted">Token</span>
                        <span className="mono" title={s.token}>{short(s.token)}</span>
                      </div>
                      <div className="row">
                        <span className="muted">Total</span>
                        <span>{groupDigits(s.total_amount)}</span>
                      </div>
                      <div className="row">
                        <span className="muted">Accrued</span>
                        <span>{groupDigits(s.accrued)}</span>
                      </div>
                      <div className="row">
                        <span className="muted">Withdrawable</span>
                        <span>{groupDigits(s.withdrawable)}</span>
                      </div>
                      <div className="meter">
                        <div className="meter-fill" style={{ width: `${Math.round(s.progress * 100)}%` }} />
                      </div>
                      <div className="row">
                        <span className="muted">
                          {s.cancelled
                            ? "Cancelled"
                            : `${Math.round(s.progress * 100)}% vested`}
                        </span>
                        {canWithdraw && (
                          <button
                            className="btn primary small"
                            onClick={() => handleWithdraw(s)}
                            disabled={busyId === s.id}
                          >
                            {busyId === s.id ? "Withdrawing…" : "Withdraw"}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
