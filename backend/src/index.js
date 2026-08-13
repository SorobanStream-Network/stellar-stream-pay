import "dotenv/config";
import express from "express";
import cors from "cors";
import { nativeToScVal, scValToNative, Horizon } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";

// ---------------------------------------------------------------------------
// Configuration (env-driven; see .env.example)
// ---------------------------------------------------------------------------
const {
  PORT = 4000,
  RPC_URL = "https://soroban-testnet.stellar.org",
  HORIZON_URL = "https://horizon-testnet.stellar.org",
  STREAM_CONTRACT_ID = "",
} = process.env;

const rpc = new Server(RPC_URL, {
  // Only allow plain-http for local RPC (e.g. localnet); always https in prod.
  allowHttp: RPC_URL.startsWith("http://"),
});

const horizon = new Horizon.Server(HORIZON_URL);

if (!STREAM_CONTRACT_ID) {
  console.warn(
    "[warn] STREAM_CONTRACT_ID is not set. Stream endpoints will return 400 until it is configured.",
  );
}

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Storage layout mirror (must match contracts/src/lib.rs):
//   * streams  -> persistent storage, key = u64 stream id (scvU64)
//   * counter  -> persistent storage, key = symbol "count"  (scvSymbol)
// The RPC `getContractData` reads these entries directly; `scValToNative`
// turns the ScVal back into plain JS (u64/i128 -> BigInt, Address -> string).
const COUNTER_KEY = nativeToScVal("count", { type: "symbol" });
const streamKey = (id) => nativeToScVal(id, { type: "u64" });

/** Read one stream's raw data; returns a decoded object or null if absent. */
async function readStream(streamId) {
  try {
    const res = await rpc.getContractData(STREAM_CONTRACT_ID, streamKey(streamId), "persistent");
    // `getContractData` returns a LedgerEntryResult whose `.val` is a
    // LedgerEntryData; for contract data the ScVal lives at `.val.value.val`.
    const scv = res.val?.value?.val;
    if (!scv) return null;
    const native = scValToNative(scv);
    return native ?? null; // scvVoid -> null means "no value"
  } catch {
    return null; // missing/archived entry (getContractData throws 404)
  }
}

/** Total stream count, from the contract's persistent counter. */
async function readStreamCount() {
  try {
    const res = await rpc.getContractData(STREAM_CONTRACT_ID, COUNTER_KEY, "persistent");
    const scv = res.val?.value?.val;
    if (!scv) return 0;
    return Number(scValToNative(scv)); // u64 -> BigInt -> number
  } catch {
    return 0; // counter never written = no streams yet
  }
}

/** Mirror the contract's linear vesting formula (all BigInt). */
function vestedAmount(total, start, end, now) {
  if (now <= start) return 0n;
  const t = now < end ? now : end;
  const elapsed = t - start;
  const duration = end - start;
  if (duration === 0n) return total;
  return (total * elapsed) / duration;
}

/** Decorate a raw stream with computed accrual/withdrawable/progress. */
function enrich(raw, id, now) {
  const accrued = vestedAmount(raw.total_amount, raw.start_time, raw.end_time, now);
  const withdrawable = raw.cancelled ? 0n : accrued - raw.withdrawn;
  const duration = raw.end_time - raw.start_time;
  const elapsed =
    now <= raw.start_time ? 0n : now < raw.end_time ? now - raw.start_time : duration;
  const progress = duration === 0n ? 1 : Number(elapsed) / Number(duration);

  return {
    id,
    sender: raw.sender,
    receiver: raw.receiver,
    token: raw.token,
    total_amount: raw.total_amount.toString(),
    withdrawn: raw.withdrawn.toString(),
    accrued: accrued.toString(),
    withdrawable: withdrawable.toString(),
    start_time: raw.start_time.toString(),
    end_time: raw.end_time.toString(),
    cancelled: raw.cancelled,
    progress: Math.min(progress, 1),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/health", async (_req, res) => {
  try {
    const network = await rpc.getNetwork();
    res.json({
      status: "ok",
      network: network.passphrase,
      protocolVersion: network.protocolVersion,
      streamContractId: STREAM_CONTRACT_ID || null,
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Active (and past) streams involving `address`, either as sender or receiver.
// We scan ids [0, streamCount) and filter in-process; for very large fleets
// swap this for event-based indexing (the contract already emits `created`,
// `withdrawn` and `cancelled` events for that purpose).
app.get("/api/stream/:address", async (req, res) => {
  if (!STREAM_CONTRACT_ID) {
    return res.status(400).json({ error: "STREAM_CONTRACT_ID is not configured on the server." });
  }

  const { address } = req.params;
  try {
    const count = await readStreamCount();
    const now = BigInt(Math.floor(Date.now() / 1000));

    // Fetch all streams concurrently, then filter.
    const ids = Array.from({ length: count }, (_, i) => i);
    const rawStreams = await Promise.all(ids.map(readStream));

    const streams = rawStreams
      .map((raw, id) => (raw ? enrich(raw, id, now) : null))
      .filter((s) => s && (s.sender === address || s.receiver === address));

    res.json({ address, network: RPC_URL, count: streams.length, streams });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Horizon balance lookup (classic accounts + SAC trustlines).
app.get("/api/account/:address", async (req, res) => {
  const { address } = req.params;
  try {
    const account = await horizon.loadAccount(address);
    res.json({
      id: account.accountId(),
      balances: account.balances.map((b) => ({
        asset: b.asset_type === "native" ? "XLM" : `${b.asset_code}:${b.asset_issuer}`,
        balance: b.balance,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`StellarStream-Pay backend listening on http://localhost:${PORT}`);
  console.log(`  RPC:     ${RPC_URL}`);
  console.log(`  Horizon: ${HORIZON_URL}`);
});
