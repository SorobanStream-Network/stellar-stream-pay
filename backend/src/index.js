import "dotenv/config";
import express from "express";
import cors from "cors";
import { nativeToScVal, scValToNative, xdr, Horizon } from "@stellar/stellar-sdk";
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

// Storage layout mirror (must match contracts/src/lib.rs `DataKey`):
//   * counter -> DataKey::Counter        == scvVec([scvSymbol("Counter")])
//   * stream  -> DataKey::Stream(u64 id) == scvVec([scvSymbol("Stream"), scvU64(id)])
// A `#[contracttype]` enum serializes as a Vec with a leading Symbol
// discriminant. The contract's `data_key_encoding_matches_backend_expectations`
// test pins these exact keys.
const COUNTER_KEY = xdr.ScVal.scvVec([nativeToScVal("Counter", { type: "symbol" })]);
const streamKey = (id) =>
  xdr.ScVal.scvVec([
    nativeToScVal("Stream", { type: "symbol" }),
    nativeToScVal(id, { type: "u64" }),
  ]);

/** Read one stream's raw data; returns a decoded object or null if absent. */
async function readStream(streamId) {
  try {
    const res = await rpc.getContractData(STREAM_CONTRACT_ID, streamKey(streamId), "persistent");
    // `getContractData` returns a LedgerEntryResult whose `.val` is a
    // LedgerEntryData union. `.value()` unwraps it to the ContractDataEntry,
    // whose `.val()` is the stored ScVal.
    const scv = res.val?.value()?.val();
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
    const scv = res.val?.value()?.val();
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
  // A cancelled stream freezes vesting at `cancelled_at`; an active one tracks
  // the ledger clock. This mirrors the contract's `vested_so_far`.
  const effectiveNow = raw.cancelled ? raw.cancelled_at : now;
  const accrued = vestedAmount(
    raw.total_amount,
    raw.start_time,
    raw.end_time,
    effectiveNow,
  );
  // After cancellation the receiver may still withdraw the portion that vested
  // before the freeze, so withdrawable is always accrued minus what was pulled.
  const withdrawable = accrued - raw.withdrawn;
  const duration = raw.end_time - raw.start_time;
  const elapsed =
    effectiveNow <= raw.start_time
      ? 0n
      : effectiveNow < raw.end_time
        ? effectiveNow - raw.start_time
        : duration;
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
// We scan ids [0, streamCount) and filter in-process. For large fleets, prefer
// event-based indexing via `/api/events` (see below) instead of scanning ids.
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

// ---------------------------------------------------------------------------
// Event-based indexing
// ---------------------------------------------------------------------------
//
// The contract publishes a `StreamEvent` on every state change with four
// topics — [kind, stream_id, sender, receiver] — and a map value carrying
// { token, amount, start_time, end_time }. Indexers poll `getEvents` (Soroban
// RPC has no websocket push yet) and fold each event into their own
// stream-state cache instead of scanning storage ids.
const EVENT_KINDS = ["created", "withdraw", "cancelled"];
// `getEvents` filters topics by base64-encoded ScVal strings; match any of the
// three kind symbols in topic position 0.
const EVENT_TOPICS_FILTER = [
  EVENT_KINDS.map((k) => nativeToScVal(k, { type: "symbol" }).toXDR("base64")),
];

/** Decode one raw RPC event into a plain, JSON-safe object. */
function decodeEvent(e) {
  const [kind, streamId, sender, receiver] = e.topic.map(scValToNative);
  // Map-format event value: { token, amount, start_time, end_time }.
  const value = scValToNative(e.value);
  return {
    kind,
    stream_id: Number(streamId),
    sender,
    receiver,
    token: value.token,
    amount: String(value.amount),
    start_time: value.start_time != null ? String(value.start_time) : null,
    end_time: value.end_time != null ? String(value.end_time) : null,
    ledger: e.ledger,
    txHash: e.txHash,
    id: e.id,
  };
}

/**
 * Query the contract's lifecycle events since `startLedger` (inclusive),
 * returning at most `limit` (≤ 100) matching events plus the pagination
 * cursor for the next page.
 */
async function queryContractEvents(startLedger = 0, limit = 100) {
  const res = await rpc.getEvents({
    startLedger,
    filters: [
      {
        type: "contract",
        contractIds: [STREAM_CONTRACT_ID],
        topics: EVENT_TOPICS_FILTER,
      },
    ],
    limit: Math.min(limit, 100),
  });
  return {
    events: res.events.map(decodeEvent),
    cursor: res.cursor,
    latestLedger: res.latestLedger,
  };
}

// Recent lifecycle events (`created` / `withdraw` / `cancelled`) for the
// contract. Page with `?startLedger=<n>` or the returned `cursor`.
app.get("/api/events", async (req, res) => {
  if (!STREAM_CONTRACT_ID) {
    return res.status(400).json({ error: "STREAM_CONTRACT_ID is not configured on the server." });
  }
  const startLedger = Number(req.query.startLedger ?? 0);
  const limit = Number(req.query.limit ?? 100);
  try {
    const { events, cursor, latestLedger } = await queryContractEvents(startLedger, limit);
    res.json({ contract: STREAM_CONTRACT_ID, count: events.length, cursor, latestLedger, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`StellarStream-Pay backend listening on http://localhost:${PORT}`);
  console.log(`  RPC:     ${RPC_URL}`);
  console.log(`  Horizon: ${HORIZON_URL}`);
});
