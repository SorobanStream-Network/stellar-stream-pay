/**
 * API tests (node:test + global fetch, no network).
 *
 * Each test builds a real Express app over an in-memory SQLite store and talks
 * to it over a loopback socket, so validation, keyset pagination, the rate
 * limiter, and the SSE handshake are all exercised end to end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/db.js";
import { createApp } from "../src/app.js";
import { createEventHub } from "../src/sse.js";

const SENDER = Keypair.random().publicKey();
const RECEIVER = Keypair.random().publicKey();
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

/** Seed `count` streams (ids 1..count) belonging to SENDER/RECEIVER. */
function seed(store, count = 3) {
  for (let id = 1; id <= count; id++) {
    store.seedStream({
      id,
      sender: SENDER,
      receiver: RECEIVER,
      token: TOKEN,
      total_amount: 1000n * BigInt(id),
      start_time: 1_000,
      end_time: 2_000,
      cliff_time: 1_000,
      withdrawn: 0n,
      cancelled: false,
      cancelled_at: 0,
    });
  }
  store.markSeeded();
}

/** Boot the app on an ephemeral port and return its base URL + teardown. */
async function boot({ seeded = true, rateLimit, store } = {}) {
  const db = store ?? openDatabase();
  if (seeded) seed(db, db.countStreams() || 3);
  const hub = createEventHub();
  const app = createApp({
    store: db,
    hub,
    contractId: CONTRACT,
    network: "Test SDF Network ; September 2015",
    now: () => 1_500,
    rateLimitOptions: rateLimit,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  return {
    db,
    hub,
    base: `http://127.0.0.1:${port}`,
    async close() {
      hub.close();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

test("rejects a malformed address with a field-level 400", async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.base}/api/stream/not-an-address`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid request");
    assert.equal(body.issues[0].path, "address");
  } finally {
    await app.close();
  }
});

test("serves /api/stream/:address from the DB with keyset pagination", async () => {
  const app = await boot();
  try {
    const first = await fetch(`${app.base}/api/stream/${SENDER}?limit=2`);
    assert.equal(first.status, 200);
    const page1 = await first.json();
    assert.equal(page1.address, SENDER);
    assert.equal(page1.count, 2);
    assert.deepEqual(page1.streams.map((s) => s.id), [1, 2]);
    assert.equal(page1.nextCursor, 2);
    // Enriched from the DB: at now=1500 of [1000, 2000] half has vested.
    assert.equal(page1.streams[0].accrued, "500");
    assert.equal(page1.streams[0].withdrawable, "500");

    const second = await fetch(`${app.base}/api/stream/${SENDER}?limit=2&cursor=${page1.nextCursor}`);
    const page2 = await second.json();
    assert.deepEqual(page2.streams.map((s) => s.id), [3]);
    assert.equal(page2.nextCursor, null, "last page reports no cursor");
  } finally {
    await app.close();
  }
});

test("paginates the persisted event log, optionally filtered by address", async () => {
  const app = await boot({ seeded: false });
  try {
    app.db.markSeeded();
    for (let i = 0; i < 3; i++) {
      app.db.applyEvent({
        kind: "created",
        stream_id: i,
        sender: SENDER,
        receiver: RECEIVER,
        token: TOKEN,
        amount: "1000",
        start_time: "1000",
        end_time: "2000",
        cliff_time: "1000",
        ledger: 10 + i,
        txHash: "0".repeat(64),
        id: `evt-${i}`,
      });
    }
    const res = await fetch(`${app.base}/api/events?limit=2&address=${RECEIVER}`);
    const body = await res.json();
    assert.equal(body.count, 2);
    assert.equal(body.nextCursor, 2);
    const next = await (await fetch(`${app.base}/api/events?limit=2&cursor=${body.nextCursor}`)).json();
    assert.equal(next.count, 1);
    assert.equal(next.nextCursor, null);
  } finally {
    await app.close();
  }
});

test("returns 503 until the startup backfill has completed", async () => {
  const store = openDatabase();
  const app = await boot({ seeded: false, store });
  try {
    const res = await fetch(`${app.base}/api/streams`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /backfilling/i);
  } finally {
    await app.close();
  }
});

test("rate-limits /api requests per client", async () => {
  const app = await boot({ rateLimit: { windowMs: 60_000, limit: 2 } });
  try {
    assert.equal((await fetch(`${app.base}/api/streams`)).status, 200);
    assert.equal((await fetch(`${app.base}/api/streams`)).status, 200);
    const third = await fetch(`${app.base}/api/streams`);
    assert.equal(third.status, 429);
    assert.match((await third.json()).error, /too many requests/i);
  } finally {
    await app.close();
  }
});

test("streams live events over SSE and filters by address", async () => {
  const app = await boot();
  try {
    const controller = new AbortController();
    const res = await fetch(`${app.base}/api/events/stream`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (needle) => {
      while (!buffer.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    };

    await readUntil("event: hello");
    assert.match(buffer, /event: hello/);

    app.hub.broadcast({ kind: "created", stream_id: 1, sender: SENDER, receiver: RECEIVER });
    await readUntil("event: stream");
    assert.match(buffer, /"kind":"created"/);

    // An event for an unrelated account must not reach a filtered subscriber.
    controller.abort();
    const unfiltered = new AbortController();
    const res2 = await fetch(`${app.base}/api/events/stream?address=${SENDER}`, {
      signal: unfiltered.signal,
    });
    const reader2 = res2.body.getReader();
    let buf2 = decoder.decode((await reader2.read()).value, { stream: true });
    const other = Keypair.random().publicKey();
    app.hub.broadcast({ kind: "created", stream_id: 2, sender: other, receiver: other });
    app.hub.broadcast({ kind: "withdraw", stream_id: 1, sender: other, receiver: SENDER });
    while (!buf2.includes("event: stream")) {
      const { value, done } = await reader2.read();
      if (done) break;
      buf2 += decoder.decode(value, { stream: true });
    }
    assert.doesNotMatch(buf2, /"stream_id":2/);
    assert.match(buf2, /"stream_id":1/);
    unfiltered.abort();
  } finally {
    await app.close();
  }
});

test("health reports index stats and unknown routes 404", async () => {
  const app = await boot();
  try {
    const health = await (await fetch(`${app.base}/health`)).json();
    assert.equal(health.status, "ok");
    assert.equal(health.streamContractId, CONTRACT);
    assert.equal(health.index.streams, 3);
    assert.equal(health.index.seeded, true);

    const missing = await fetch(`${app.base}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});
