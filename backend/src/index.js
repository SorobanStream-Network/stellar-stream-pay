import "dotenv/config";
import express from "express";
import cors from "cors";
import { Horizon } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import {
  enrichStream,
  queryContractEvents,
  startIndexer,
} from "./indexer.js";

// ---------------------------------------------------------------------------
// Configuration (env-driven; see .env.example)
// ---------------------------------------------------------------------------
const {
  PORT = 4000,
  RPC_URL = "https://soroban-testnet.stellar.org",
  HORIZON_URL = "https://horizon-testnet.stellar.org",
  STREAM_CONTRACT_ID = "",
  // Event indexer tuning (see src/indexer.js):
  //   INDEX_POLL_MS       — forward-poll cadence (default 15s).
  //   INDEX_START_LEDGER  — >0: pure event backfill from this ledger; unset/0:
  //                         seed once from a storage scan, then events forward.
  INDEX_POLL_MS = 15_000,
  INDEX_START_LEDGER = 0,
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

// ---------------------------------------------------------------------------
// Event index — the in-memory source of truth for stream state.
// ---------------------------------------------------------------------------
// The indexer seeds once (storage scan by default, or event backfill from
// INDEX_START_LEDGER) and then polls `getEvents` forward, folding
// created/withdraw/cancelled/split_created events into an in-memory Map. The
// stream routes below read from it instead of scanning storage ids `0..count`
// on every request. Routes return 503 until the seed completes (fresh
// deploys with no streams seed instantly).
const { index, stop: stopIndexer } = startIndexer({
  rpc,
  contractId: STREAM_CONTRACT_ID,
  startLedger: Number(INDEX_START_LEDGER) || 0,
  pollMs: Number(INDEX_POLL_MS) || 15_000,
});

const app = express();
app.use(cors());
app.use(express.json());

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
      indexSeeded: index.seeded,
      indexedStreams: index.streams.size,
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

/** 503 helper while the index backfill is still running. */
function requireIndex(res) {
  if (!STREAM_CONTRACT_ID) {
    res.status(400).json({ error: "STREAM_CONTRACT_ID is not configured on the server." });
    return false;
  }
  if (!index.seeded) {
    res.status(503).json({
      error: "Stream index is still seeding — retry in a few seconds.",
      reason: index.seedError ?? null,
    });
    return false;
  }
  return true;
}

// All indexed streams (event-folded state, enriched with vesting math).
app.get("/api/streams", async (_req, res) => {
  if (!requireIndex(res)) return;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const streams = [...index.streams.values()]
    .sort((a, b) => a.id - b.id)
    .map((s) => enrichStream(s, now));
  res.json({ network: RPC_URL, count: streams.length, streams });
});

// Streams involving `address`, either as sender or receiver — served from the
// event index, not a per-request storage scan.
app.get("/api/stream/:address", async (req, res) => {
  if (!requireIndex(res)) return;
  const { address } = req.params;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const streams = [...index.streams.values()]
    .filter((s) => s.sender === address || s.receiver === address)
    .sort((a, b) => a.id - b.id)
    .map((s) => enrichStream(s, now));
  res.json({ address, network: RPC_URL, count: streams.length, streams });
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

// Raw lifecycle events (`created` / `withdraw` / `cancelled` + splits) for
// the contract. Page with `?cursor=<n>` (from a previous response) or query a
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
      rpc,
      contractId: STREAM_CONTRACT_ID,
      startLedger,
      cursor,
      limit,
    });
    res.json({
      contract: STREAM_CONTRACT_ID,
      count: events.length,
      cursor: nextCursor,
      latestLedger,
      events,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Graceful shutdown for the poller (SIGTERM in containers).
process.on("SIGTERM", () => {
  stopIndexer();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`StellarStream-Pay backend listening on http://localhost:${PORT}`);
  console.log(`  RPC:     ${RPC_URL}`);
  console.log(`  Horizon: ${HORIZON_URL}`);
});
