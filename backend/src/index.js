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

// Storage layout mirror (must match contracts/core/src/lib.rs `DataKey`):
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
// { token, amount, receiver_amount, start_time, end_time }. It also publishes
// a `SplitEvent` once per split group with topics [kind, root_id, sender] and
// a map value carrying { token, member_ids, total_amount }. Indexers poll
// `getEvents` (Soroban RPC has no websocket push yet) and fold each event into
// their own stream-state cache instead of scanning storage ids.
const EVENT_KINDS = ["created", "withdraw", "cancelled"];
// `getEvents` matches topics via a list of filters, each an array of
// SegmentMatchers ("*" = one topic, "**" = one-or-more topics, or a base64
// ScVal for an exact match). A `#[contractevent]` publishes its name
// ("stream_event" / "split_event") as topic[0] and the `#[topic]` fields after
// it, so the kind symbol lives at topic[1]. We OR one filter per kind and let
// "**" swallow the trailing topics.
const EVENT_TOPICS_FILTER = EVENT_KINDS.map((k) => [
  nativeToScVal("stream_event", { type: "symbol" }).toXDR("base64"),
  nativeToScVal(k, { type: "symbol" }).toXDR("base64"),
  "**",
]);
// Split-group membership event (published once per group at creation).
const SPLIT_EVENT_TOPICS_FILTER = [
  nativeToScVal("split_event", { type: "symbol" }).toXDR("base64"),
  nativeToScVal("split_created", { type: "symbol" }).toXDR("base64"),
  "**",
];

/** Decode one raw RPC event into a plain, JSON-safe object. */
function decodeEvent(e) {
  const topics = e.topic.map(scValToNative);
  const value = scValToNative(e.value);
  if (topics[0] === "split_event") {
    // Topics: [event_name, kind, root_id, sender].
    const [, kind, rootId, sender] = topics;
    return {
      kind,
      root_id: Number(rootId),
      sender,
      token: value.token,
      member_ids: (value.member_ids ?? []).map(Number),
      total_amount: value.total_amount != null ? String(value.total_amount) : null,
      ledger: e.ledger,
      txHash: e.txHash,
      id: e.id,
    };
  }
  // Stream event. Topics: [event_name, kind, stream_id, sender, receiver].
  const [, kind, streamId, sender, receiver] = topics;
  return {
    kind,
    stream_id: Number(streamId),
    sender,
    receiver,
    token: value.token,
    amount: String(value.amount),
    receiver_amount: value.receiver_amount != null ? String(value.receiver_amount) : null,
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
async function queryContractEvents({ startLedger, cursor, limit = 100 }) {
  // Soroban RPC's `getEvents` scans a bounded number of ledgers per request
  // (~10k), so a wide default range can silently return no results even when
  // matching events exist. Default to a recent ~1000-ledger window (~83 min)
  // when neither a cursor nor an explicit startLedger is supplied.
  const params = {
    filters: [
      {
        type: "contract",
        contractIds: [STREAM_CONTRACT_ID],
        topics: [...EVENT_TOPICS_FILTER, SPLIT_EVENT_TOPICS_FILTER],
      },
    ],
    limit: Math.min(limit, 100),
  };
  if (cursor) {
    params.cursor = cursor;
  } else {
    if (startLedger === undefined) {
      const latest = await rpc.getLatestLedger();
      const WINDOW = 1000;
      startLedger = latest.sequence > WINDOW ? latest.sequence - WINDOW : 1;
    }
    params.startLedger = startLedger;
  }
  const res = await rpc.getEvents(params);
  return {
    events: res.events.map(decodeEvent),
    cursor: res.cursor,
    latestLedger: res.latestLedger,
  };
}

// Recent lifecycle events (`created` / `withdraw` / `cancelled`) for the
// contract. Page with `?cursor=<n>` (from a previous response) or query a
// ledger range with `?startLedger=<n>`.
app.get("/api/events", async (req, res) => {
  if (!STREAM_CONTRACT_ID) {
    return res.status(400).json({ error: "STREAM_CONTRACT_ID is not configured on the server." });
  }
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const startLedger = req.query.startLedger === undefined
    ? undefined
    : Number(req.query.startLedger);
  const limit = Number(req.query.limit ?? 100);
  if (cursor && startLedger !== undefined) {
    return res.status(400).json({ error: "Use either `cursor` or `startLedger`, not both." });
  }
  // Soroban RPC requires startLedger >= 1 (ledgers are 1-indexed).
  if (startLedger !== undefined && (!Number.isInteger(startLedger) || startLedger < 1)) {
    return res.status(400).json({ error: "startLedger must be a positive integer" });
  }
  try {
    const { events, cursor: nextCursor, latestLedger } = await queryContractEvents({
      startLedger,
      cursor,
      limit,
    });
    res.json({ contract: STREAM_CONTRACT_ID, count: events.length, cursor: nextCursor, latestLedger, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`StellarStream-Pay backend listening on http://localhost:${PORT}`);
  console.log(`  RPC:     ${RPC_URL}`);
  console.log(`  Horizon: ${HORIZON_URL}`);
});
