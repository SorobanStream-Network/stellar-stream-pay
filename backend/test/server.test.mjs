/**
 * Wiring test for `src/index.js`.
 *
 * The API and indexer are unit-tested separately, but the entrypoint itself
 * (env parsing, SQLite wiring, indexer startup, signal handling) is only
 * exercised when the module is imported — which is exactly where a syntax error
 * or a bad `??`/`||` mix would otherwise reach production as a container that
 * boots and immediately exits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/db.js";
import { startServer } from "../src/index.js";

const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const quiet = { log() {}, warn() {}, error() {} };

test("boots the server end to end and serves the API", async () => {
  const store = openDatabase();
  const sender = Keypair.random().publicKey();
  const receiver = Keypair.random().publicKey();
  store.seedStream({
    id: 1,
    sender,
    receiver,
    token: CONTRACT,
    total_amount: 1_000n,
    start_time: 1_000,
    end_time: 2_000,
    cliff_time: 1_000,
    withdrawn: 0n,
    cancelled: false,
    cancelled_at: 0,
  });
  store.markSeeded();
  // A persisted cursor means the indexer resumes instead of touching RPC.
  store.setCursor("cursor-1");

  const { server, shutdown } = startServer({
    env: {
      STREAM_CONTRACT_ID: CONTRACT,
      DATABASE_PATH: ":memory:",
      INDEX_POLL_MS: "60000",
    },
    // Any accidental RPC call should fail loudly rather than hit the network.
    rpc: {
      async getContractData() {
        throw new Error("unexpected RPC call: the index should resume from its cursor");
      },
      async getEvents() {
        return { events: [], cursor: "cursor-1", latestLedger: 10 };
      },
    },
    store,
    port: 0,
    logger: quiet,
  });

  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.streamContractId, CONTRACT);
    assert.equal(health.index.streams, 1);
    assert.equal(health.index.seeded, true);

    const streams = await (await fetch(`${base}/api/stream/${sender}`)).json();
    assert.equal(streams.count, 1);
    assert.equal(streams.streams[0].id, 1);
  } finally {
    await shutdown();
  }
});
