/**
 * StellarStream-Pay backend — SQLite-backed event indexer + JSON API.
 *
 * Startup sequence:
 *   1. open (or create) the index database at `DATABASE_PATH`,
 *   2. create the SSE hub,
 *   3. start the event indexer — it resumes from the persisted cursor, or
 *      backfills storage / events on a cold start (see `indexer.js`),
 *   4. serve the API from the database.
 *
 * Routes return 503 until the first backfill lands, so a client never sees a
 * half-built index as "no streams".
 */
import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Horizon } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import { startIndexer } from "./indexer.js";
import { createEventHub } from "./sse.js";

/**
 * Wire the process together. Exported (rather than run inline) so tests can
 * build the same object graph with a fake RPC and an in-memory database.
 */
export function startServer({
  env = process.env,
  rpc: injectedRpc,
  store: injectedStore,
  port = undefined,
  logger = console,
} = {}) {
  const {
    PORT = 4000,
    RPC_URL = "https://soroban-testnet.stellar.org",
    HORIZON_URL = "https://horizon-testnet.stellar.org",
    NETWORK_PASSPHRASE = "Test SDF Network ; September 2015",
    STREAM_CONTRACT_ID = "",
    DATABASE_PATH = "./data/streams.db",
    INDEX_POLL_MS = 15_000,
    INDEX_START_LEDGER = 0,
    RATE_LIMIT_WINDOW_MS = 60_000,
    RATE_LIMIT_MAX = 240,
  } = env;

  if (!STREAM_CONTRACT_ID) {
    logger.warn(
      "[warn] STREAM_CONTRACT_ID is not set. Stream endpoints will return 400 until it is configured.",
    );
  }

  // SQLite needs its directory to exist; the container mounts `/data`.
  if (!injectedStore && DATABASE_PATH !== ":memory:") {
    mkdirSync(dirname(resolve(DATABASE_PATH)), { recursive: true });
  }

  const rpc =
    injectedRpc ?? new Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });
  const store = injectedStore ?? openDatabase(DATABASE_PATH);
  const hub = createEventHub();

  const indexer = STREAM_CONTRACT_ID
    ? startIndexer({
        rpc,
        contractId: STREAM_CONTRACT_ID,
        store,
        startLedger: Number(INDEX_START_LEDGER) || 0,
        pollMs: Number(INDEX_POLL_MS) || 15_000,
        logger,
        // Every newly folded event goes out to connected dashboards.
        onEvent: (event) => hub.broadcast(event),
      })
    : null;

  const app = createApp({
    store,
    hub,
    contractId: STREAM_CONTRACT_ID,
    network: NETWORK_PASSPHRASE,
    rpc,
    horizon: HORIZON_URL ? new Horizon.Server(HORIZON_URL) : null,
    rateLimitOptions: {
      windowMs: Number(RATE_LIMIT_WINDOW_MS) || 60_000,
      limit: Number(RATE_LIMIT_MAX) || 240,
    },
  });

  // `??` and `||` cannot be mixed without parentheses (that is a SyntaxError,
  // not a precedence quirk), so the listen port is resolved in one place.
  const listenPort = port ?? (Number(PORT) || undefined);
  const server = app.listen(listenPort, () => {
    const address = server.address();
    const shown =
      typeof address === "object" && address?.port ? address.port : listenPort ?? PORT;
    logger.log(`StellarStream-Pay backend listening on http://localhost:${shown}`);
    logger.log(`  RPC:      ${RPC_URL}`);
    logger.log(`  Horizon:  ${HORIZON_URL}`);
    logger.log(`  Database: ${injectedStore ? ":memory:" : DATABASE_PATH}`);
  });

  /**
   * Stop the indexer, SSE hub, HTTP server, and database. Returns a promise so
   * tests can await a clean teardown; the signal handler is what exits.
   */
  const shutdown = () =>
    new Promise((resolve) => {
      indexer?.stop();
      hub.close();
      server.close(() => {
        store.close();
        resolve();
      });
    });

  const onSignal = () => {
    void shutdown().then(() => process.exit(0));
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  return { app, server, store, hub, indexer, shutdown };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startServer();
