/**
 * stream-core TTL keeper / relayer.
 *
 * stream-core (v3) exposes two permissionless entrypoints that re-arm the
 * lease on its ledger entries:
 *
 *   `bump(stream_id)` — re-arms the stream's persistent entry to max TTL.
 *     As a side effect it also re-arms the contract instance + Wasm code,
 *     the id counter, the admin/pause config, and the split-group entry
 *     when `stream_id` is a split-group root.
 *   `bump_instance()` — re-arms the contract INSTANCE + Wasm CODE entries
 *     (plus admin/pause/counter when present) so a fully idle vault is
 *     never archived.
 *
 * This process keeps both alive on a schedule:
 *
 *   1. Every pass sends `bump_instance()` once (a single transaction).
 *      Instance/code entries have no per-stream bump path, so they are
 *      re-armed unconditionally; the contract's `extend_ttl` is a no-op
 *      when the entry is already at the ceiling, so host cost stays minimal.
 *   2. It reads the remaining TTL of every stream entry via `getLedgerEntries`
 *      (one batched RPC call) and sends `bump_many([ids])` only for streams
 *      whose remaining TTL is below `thresholdLedgers`, chunked into batches
 *      of `KEEPER_BUMP_BATCH` (default 4) — so a fleet pays one tx per batch
 *      per pass instead of one per stream, and gas still tracks need.
 *   3. If a batch fails (the deployed contract predates `bump_many` — v3 — or
 *      the batch exceeds the per-tx footprint), it falls back to per-stream
 *      `bump` calls so nothing is ever left un-re-armed.
 *
 * The keeper needs a funded account — any account works, because the calls
 * are permissionless and only pay gas. Run it as:
 *
 *   KEEPER_SECRET=S... npm run keeper            # scheduler (daily by default)
 *   KEEPER_SECRET=S... npm run keeper:once       # single pass, exit
 *   KEEPER_SECRET=S... npm run keeper -- --dry-run   # plan only, no txs
 *
 * or via Docker Compose (`docker compose up -d keeper`). For cron-style
 * operation, call `keeper:once` from a scheduler instead of the long-running
 * loop.
 */
import "dotenv/config";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import {
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";

// ---------------------------------------------------------------------------
// Configuration (env-driven; see backend/.env.example)
// ---------------------------------------------------------------------------
const {
  RPC_URL = "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE = "Test SDF Network ; September 2015",
  STREAM_CONTRACT_ID = "",
  KEEPER_SECRET = "",
  KEEPER_DRY_RUN = "",
} = process.env;

// Ledgers close roughly every 5s, so 30 days ≈ 518,400 ledgers. This matches
// the contract's own `bump_ttl` threshold, so the keeper steps in before an
// entry gets within one write-cycle of expiry. Both are overridable.
const KEEPER_TTL_THRESHOLD = Number(process.env.KEEPER_TTL_THRESHOLD ?? 30 * 24 * 60 * 12);
const KEEPER_INTERVAL_MIN = Number(process.env.KEEPER_INTERVAL_MIN ?? 60 * 24); // daily
// Stream ids per `bump_many` call; clamped to the contract's MAX_BUMP_BATCH.
const KEEPER_BUMP_BATCH = process.env.KEEPER_BUMP_BATCH ? Number(process.env.KEEPER_BUMP_BATCH) : 4;
const DRY_RUN =
  process.argv.includes("--dry-run") ||
  KEEPER_DRY_RUN === "1" ||
  KEEPER_DRY_RUN.toLowerCase() === "true";

const rpc = new Server(RPC_URL, {
  // Only allow plain-http for local RPC (e.g. localnet); always https in prod.
  allowHttp: RPC_URL.startsWith("http://"),
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Storage layout mirror — identical to src/index.js (the contract's
// `data_key_encoding_matches_backend_expectations` test pins these keys).
// ---------------------------------------------------------------------------
const COUNTER_KEY = xdr.ScVal.scvVec([nativeToScVal("Counter", { type: "symbol" })]);
const streamKey = (id) =>
  xdr.ScVal.scvVec([
    nativeToScVal("Stream", { type: "symbol" }),
    nativeToScVal(id, { type: "u64" }),
  ]);

/**
 * Pass-status monitor: records the outcome of every keeper pass and exposes
 * it over a tiny HTTP endpoint so operators (and container probes) can verify
 * that re-arming is actually happening.
 *
 *   GET /health  — liveness: the process is up.
 *   GET /status  — last pass result (ok, counts, failures, duration) + error.
 *   GET /metrics — Prometheus text-format exposition for scrapers (Grafana
 *                  alerting): monotonic counters for bumps/batches/failures/
 *                  passes and last-pass gauges (timestamp, ok, duration,
 *                  counts).
 *
 * A structured one-line JSON status is also written to stdout per pass:
 *   {"event":"keeper_pass","ts":"...","ok":true,"streams":2,"due":2,
 *    "covered":2,"instanceBumped":true,"dryRun":false,"failed":[],"durationMs":123}
 *
 * `record` stores a successful/failed-with-items pass; `recordError` stores a
 * pass that failed outright (e.g. bad config, unreachable RPC) while keeping
 * the last recorded pass visible. Both are surfaced by `/status`.
 */
export function createMonitor({ nextPassInSec = null } = {}) {
  const state = {
    startedAt: new Date().toISOString(),
    lastPass: null,
    lastError: null,
    nextPassInSec,
    // Prometheus counters — monotonic across passes (see `metrics`).
    passesTotal: 0,
    passFailuresTotal: 0,
    bumpsTotal: 0,
    batchesTotal: 0,
    failuresTotal: 0,
    // Most recent pass attempt, regardless of outcome (last-pass gauges).
    lastPassAt: null,
    lastPassOk: null,
  };
  const uptimeSec = () =>
    Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000);
  // Closure so both the exposed method and the HTTP handlers share one shape.
  const status = () => ({
    status: state.lastError ? "degraded" : "ok",
    startedAt: state.startedAt,
    uptimeSec: uptimeSec(),
    nextPassInSec: state.nextPassInSec,
    lastPass: state.lastPass,
    lastError: state.lastError,
  });

  const record = (pass) => {
    state.lastPass = { ts: new Date().toISOString(), ...pass };
    state.lastError = null;
    state.lastPassAt = Date.now();
    state.lastPassOk = pass.ok !== false;
    state.passesTotal += 1;
    if (!state.lastPassOk) state.passFailuresTotal += 1;
    // Dry-run passes send nothing, so they must not inflate the work
    // counters that Grafana alerts on (bumps/batches/failures).
    if (!pass.dryRun) {
      state.bumpsTotal += pass.covered ?? 0;
      state.batchesTotal += pass.batches ?? 0;
      state.failuresTotal += pass.failed?.length ?? 0;
    }
  };

  const recordError = (message) => {
    state.lastError = typeof message === "string" ? message : String(message);
    state.lastPassAt = Date.now();
    state.lastPassOk = false;
    state.passesTotal += 1;
    state.passFailuresTotal += 1;
    state.failuresTotal += 1;
  };

  /**
   * Prometheus text-format exposition of pass counters and last-pass
   * gauges, served at `GET /metrics`. Counters are monotonic across
   * passes; gauges reflect the most recent pass attempt. A fresh process
   * (no pass yet) emits zero values so every series exists from the first
   * scrape.
   */
  const metrics = () => {
    const lines = [];
    const series = (type, name, help, value) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name} ${value}`);
    };
    series("gauge", "stream_core_keeper_up", "Whether the keeper process is running.", 1);
    series(
      "counter",
      "stream_core_keeper_passes_total",
      "Total keeper passes recorded.",
      state.passesTotal,
    );
    series(
      "counter",
      "stream_core_keeper_pass_failures_total",
      "Passes that did not complete successfully (failed items or outright errors).",
      state.passFailuresTotal,
    );
    series(
      "counter",
      "stream_core_keeper_bumps_total",
      "Total stream entries re-armed (covered) across passes.",
      state.bumpsTotal,
    );
    series(
      "counter",
      "stream_core_keeper_batches_total",
      "Total successful bump_many batch calls.",
      state.batchesTotal,
    );
    series(
      "counter",
      "stream_core_keeper_failures_total",
      "Total failed keeper actions, including outright pass failures.",
      state.failuresTotal,
    );
    series(
      "gauge",
      "stream_core_keeper_last_pass_timestamp_seconds",
      "Unix time (seconds) of the most recent pass attempt.",
      state.lastPassAt ? state.lastPassAt / 1000 : 0,
    );
    series(
      "gauge",
      "stream_core_keeper_last_pass_ok",
      "1 if the most recent pass succeeded, 0 otherwise.",
      state.lastPassOk ? 1 : 0,
    );
    series(
      "gauge",
      "stream_core_keeper_last_pass_duration_seconds",
      "Duration of the most recent pass, in seconds.",
      state.lastPass?.durationMs ? state.lastPass.durationMs / 1000 : 0,
    );
    series(
      "gauge",
      "stream_core_keeper_streams",
      "Streams seen in the most recent pass.",
      state.lastPass?.streams ?? 0,
    );
    series(
      "gauge",
      "stream_core_keeper_due_streams",
      "Streams below the TTL threshold in the most recent pass.",
      state.lastPass?.due ?? 0,
    );
    series(
      "gauge",
      "stream_core_keeper_covered_streams",
      "Streams re-armed in the most recent pass.",
      state.lastPass?.covered ?? 0,
    );
    series(
      "gauge",
      "stream_core_keeper_instance_bumped",
      "1 if the contract instance/code lease was re-armed in the most recent pass.",
      state.lastPass?.instanceBumped ? 1 : 0,
    );
    return `${lines.join("\n")}\n`;
  };

  /**
   * Start the monitoring HTTP server. Returns the server so callers/tests
   * can close it; listen errors are logged, never fatal (monitoring is
   * ancillary to re-arming). Bind `host`/`port` explicitly; defaults are
   * localhost + an OS-assigned port (use `KEEPER_HEALTH_PORT` in prod).
   */
  const startHttp = ({ host = "127.0.0.1", port = 0 } = {}) => {
    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && pathname === "/health") {
        res.setHeader("content-type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", startedAt: state.startedAt, uptimeSec: uptimeSec() }));
      } else if (req.method === "GET" && pathname === "/status") {
        res.setHeader("content-type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(status()));
      } else if (req.method === "GET" && pathname === "/metrics") {
        res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
        res.writeHead(200);
        res.end(metrics());
      } else {
        res.setHeader("content-type", "application/json");
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    server.on("error", (err) => {
      console.warn(`[keeper] health server unavailable: ${err.message}`);
    });
    server.listen(port, host);
    return server;
  };

  return { record, recordError, status, metrics, startHttp };
}

/** Build the keeper for one contract / account. Factory (rather than a module
 * singleton) so tests can inject a fake RPC and the pass logic stays fully
 * exercisable without a network or a real funded account.
 *
 * @param {object} opts
 * @param {import("@stellar/stellar-sdk/rpc").Server | object} opts.rpc
 * @param {string} opts.contractId  stream-core contract id (C...)
 * @param {string} opts.secret      funded keeper account secret key (S...)
 * @param {string} [opts.networkPassphrase]
 * @param {number} [opts.thresholdLedgers]  bump streams with less remaining TTL
 * @param {number} [opts.bumpBatchSize]     stream ids per `bump_many` call
 *                                          (clamped to the contract's cap; default 4)
 * @param {boolean} [opts.dryRun]           plan only, never submit
 */
export function createKeeper({
  rpc: server,
  contractId,
  networkPassphrase,
  secret,
  thresholdLedgers = 30 * 24 * 60 * 12,
  bumpBatchSize = 4,
  dryRun = false,
}) {
  if (!contractId) {
    throw new Error("STREAM_CONTRACT_ID is not set — the keeper cannot run.");
  }
  if (!secret) {
    throw new Error("KEEPER_SECRET is not set — the keeper needs a funded account to pay gas.");
  }
  let keypair;
  try {
    keypair = Keypair.fromSecret(secret);
  } catch {
    throw new Error("KEEPER_SECRET is not a valid Stellar secret key (S...).");
  }

  const contract = new Contract(contractId);

  // `bump_many` is capped on-chain (MAX_BUMP_BATCH = 32); clamp here so a
  // misconfigured env can't guarantee a rejected batch.
  const MAX_CONTRACT_BUMP_BATCH = 32;
  const batchSize =
    Number.isInteger(bumpBatchSize) && bumpBatchSize >= 1
      ? Math.min(bumpBatchSize, MAX_CONTRACT_BUMP_BATCH)
      : 4;

  /** LedgerKey for a persistent contract-data entry of our contract. */
  const contractDataKey = (key) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contract.address().toScAddress(),
        key,
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );

  /** Total stream count from the contract's persistent counter. */
  async function readStreamCount() {
    const res = await server.getContractData(contractId, COUNTER_KEY, "persistent");
    const scv = res.val?.value()?.val();
    if (!scv) return 0; // scvVoid -> no value
    return Number(scValToNative(scv)); // u64 -> BigInt -> number
  }

  /**
   * Remaining TTL (ledgers from the latest ledger) per requested entry, keyed
   * by the base64 of its LedgerKey. Archived/missing entries are absent.
   * Batched because RPC nodes cap the number of keys per request.
   */
  async function readRemainingTtls(keys) {
    const out = new Map();
    const BATCH = 100;
    for (let i = 0; i < keys.length; i += BATCH) {
      const res = await server.getLedgerEntries(...keys.slice(i, i + BATCH));
      for (const entry of res.entries) {
        if (entry.liveUntilLedgerSeq != null) {
          out.set(entry.key.toXDR("base64"), entry.liveUntilLedgerSeq - res.latestLedger);
        }
      }
    }
    return out;
  }

  /** Poll `getTransaction` until the tx reaches a terminal state. */
  async function pollToSuccess(hash, label) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const res = await server.getTransaction(hash);
      if (res.status === "NOT_FOUND") {
        await sleep(1000);
        continue;
      }
      if (res.status === "SUCCESS") return hash;
      throw new Error(`${label} failed on-chain: ${res.status} (${hash})`);
    }
    throw new Error(`${label} timed out waiting for a terminal status (${hash})`);
  }

  /**
   * Simulate, sign, and submit one permissionless keeper call. Returns the
   * transaction hash. Sequential calls re-fetch the account so sequence
   * numbers stay correct — callers must await before sending the next tx.
   */
  async function sendBump(label, method, args = []) {
    const source = await server.getAccount(keypair.publicKey());
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    // Simulation assembles the footprint + real resource fee; the keeper
    // signs itself (no wallet), so the tx can go straight out.
    const prepared = await server.prepareTransaction(tx);
    prepared.sign(keypair);

    const sent = await server.sendTransaction(prepared);
    if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
      throw new Error(`${label} rejected by the network: ${sent.status}`);
    }
    return pollToSuccess(sent.hash, label);
  }

  /**
   * Run one keeper pass:
   *  - `bump_instance()` once (instance + code + admin/pause/counter),
   *  - `bump(id)` for every stream entry whose remaining TTL is below
   *    `thresholdLedgers`.
   *
   * Returns `{ summary, failed }` — `failed` is a list of per-item errors so
   * callers (cron, CI) can exit non-zero when anything didn't get re-armed.
   * A single failing stream never aborts the rest of the pass.
   */
  async function runPass() {
    let count;
    try {
      count = await readStreamCount();
    } catch (err) {
      // `getContractData` throws a 404-shaped object when the contract or the
      // counter entry is missing — that's a configuration error, not a pass
      // we can continue.
      throw new Error(
        `could not read stream count from ${contractId} — is STREAM_CONTRACT_ID correct? (${err.message})`,
      );
    }

    const lines = [
      `keeper ${keypair.publicKey()} — ${count} stream(s), ` +
        `threshold ${thresholdLedgers} ledgers` +
        (dryRun ? ", DRY RUN (no transactions)" : ""),
    ];
    const failed = [];
    // Pass metrics for the status monitor (see `createMonitor`).
    let instanceBumped = false;
    let covered = 0; // streams actually re-armed this pass
    let batches = 0; // successful `bump_many` batch calls

    // Decide which streams need a bump: only those actually near expiry.
    const due = [];
    if (count > 0) {
      const ids = Array.from({ length: count }, (_, i) => i);
      const keys = ids.map((id) => contractDataKey(streamKey(id)));
      const remaining = await readRemainingTtls(keys);
      for (const id of ids) {
        const ttl = remaining.get(keys[id].toXDR("base64"));
        if (ttl === undefined) {
          lines.push(`  stream ${id}: entry missing/archived — skip`);
          continue;
        }
        if (ttl < thresholdLedgers) due.push({ id, ttl });
      }
    }

    /** Submit one call (or just log it in dry-run), isolating failures. */
    const submit = async (label, method, args) => {
      if (dryRun) {
        lines.push(`  ${label}: would send`);
        return false;
      }
      try {
        const hash = await sendBump(label, method, args);
        lines.push(`  ${label}: ${hash}`);
        return true;
      } catch (err) {
        failed.push(`${label}: ${err.message}`);
        lines.push(`  ${label}: FAILED — ${err.message}`);
        return false;
      }
    };

    // 1. Re-arm the instance + code (and admin/pause/counter) — always. One
    //    tx per pass; the contract's extend_ttl no-ops at the ceiling.
    if (await submit("bump_instance()", "bump_instance", [])) instanceBumped = true;

    // 2. Re-arm only the streams that are close to expiry, batched into
    //    `bump_many` calls so a fleet pays one tx per batch per pass. If a
    //    batch fails — the deployed contract predates `bump_many` (v3), or
    //    the batch exceeds the per-tx footprint — fall back to per-stream
    //    `bump` calls so nothing is left un-re-armed.
    for (let i = 0; i < due.length; i += batchSize) {
      const chunk = due.slice(i, i + batchSize);
      const ids = chunk.map((d) => d.id);
      const label = `bump_many([${ids.join(", ")}])`;
      if (dryRun) {
        lines.push(`  ${label}: would send`);
        continue;
      }
      try {
        // v16 `nativeToScVal` takes a per-element type array for vectors; a
        // bare `{ type: "vec" }` is rejected and mixed spec lengths would
        // auto-detect trailing elements as i128 instead of u64.
        const hash = await sendBump(label, "bump_many", [
          nativeToScVal(ids, { type: ids.map(() => "u64") }),
        ]);
        lines.push(`  ${label}: ${hash}`);
        covered += chunk.length;
        batches += 1;
      } catch (err) {
        lines.push(`  ${label}: FAILED (${err.message}) — falling back to individual bumps`);
        for (const { id, ttl } of chunk) {
          if (await submit(`bump(${id}) [${ttl} ledgers left]`, "bump", [
            nativeToScVal(id, { type: "u64" }),
          ])) {
            covered += 1;
          }
        }
      }
    }
    if (due.length === 0) lines.push("  all stream entries above threshold — nothing to bump");

    return {
      summary: lines.join("\n"),
      failed,
      metrics: { streams: count, due: due.length, covered, batches, instanceBumped, dryRun },
    };
  }

  return { runPass, sendBump };
}

/**
 * Env-driven single pass (used by the CLI and `--once` mode). Throws on
 * configuration/network errors; per-item failures are returned, not thrown.
 *
 * Every pass records its outcome in the process monitor and emits one
 * structured JSON status line on stdout (see {@link createMonitor}) so log
 * shippers can alert on `ok:false` or on passes where nothing was covered.
 */
// Scheduler cadence for the monitor's /status payload (null in `--once` mode).
const monitor = createMonitor({
  nextPassInSec:
    Number.isInteger(KEEPER_INTERVAL_MIN) && KEEPER_INTERVAL_MIN >= 1
      ? KEEPER_INTERVAL_MIN * 60
      : null,
});

export async function runKeeperPass() {
  const keeper = createKeeper({
    rpc,
    contractId: STREAM_CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    secret: KEEPER_SECRET,
    thresholdLedgers: KEEPER_TTL_THRESHOLD,
    bumpBatchSize: KEEPER_BUMP_BATCH,
    dryRun: DRY_RUN,
  });
  const started = Date.now();
  try {
    const { summary, failed, metrics } = await keeper.runPass();
    const status = {
      ok: failed.length === 0,
      ...metrics,
      failed,
      durationMs: Date.now() - started,
    };
    monitor.record(status);
    console.log(JSON.stringify({ event: "keeper_pass", ts: new Date().toISOString(), ...status }));
    return { summary, failed };
  } catch (err) {
    const status = {
      ok: false,
      error: err.message,
      durationMs: Date.now() - started,
    };
    monitor.recordError(status.error);
    console.log(JSON.stringify({ event: "keeper_pass", ts: new Date().toISOString(), ...status }));
    throw err;
  }
}

/** Start the long-running scheduler: one pass now, then on an interval. */
export function startKeeper() {
  if (!Number.isInteger(KEEPER_INTERVAL_MIN) || KEEPER_INTERVAL_MIN < 1) {
    console.error(`[keeper] KEEPER_INTERVAL_MIN must be a whole number >= 1 (got ${KEEPER_INTERVAL_MIN})`);
    process.exit(1);
  }

  // Monitoring: a small HTTP endpoint so container probes / operators can see
  // the process is up and the last pass succeeded. Disable with port <= 0.
  const healthPort = Number(process.env.KEEPER_HEALTH_PORT ?? 4300);
  const healthHost = process.env.KEEPER_HEALTH_HOST ?? "127.0.0.1";
  if (Number.isInteger(healthPort) && healthPort > 0) {
    monitor.startHttp({ host: healthHost, port: healthPort });
    console.log(`[keeper] monitoring: http://${healthHost}:${healthPort} (health, status, metrics)`);
  } else {
    console.log("[keeper] health endpoint disabled (KEEPER_HEALTH_PORT <= 0)");
  }

  const run = async (reason) => {
    try {
      console.log(`[keeper] === pass (${reason}) ===`);
      const { summary, failed } = await runKeeperPass();
      console.log(summary);
      if (failed.length > 0) {
        console.error(`[keeper] ${failed.length} action(s) failed this pass`);
      }
    } catch (err) {
      console.error(`[keeper] pass failed: ${err.message}`);
    }
  };

  run("startup");
  setInterval(() => run("scheduled"), KEEPER_INTERVAL_MIN * 60_000);
}

// CLI entry: `node src/keeper.js` (scheduler), `--once` (single pass + exit),
// `--dry-run` (plan only, works with either mode).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // `--dry-run` is a one-shot plan pass by default; combine with nothing else.
  const once = process.argv.includes("--once") || DRY_RUN;
  if (once) {
    runKeeperPass()
      .then(({ summary, failed }) => {
        console.log(summary);
        process.exit(failed.length > 0 ? 1 : 0);
      })
      .catch((err) => {
        console.error(`[keeper] ${err.message}`);
        process.exit(1);
      });
  } else {
    startKeeper();
  }
}
