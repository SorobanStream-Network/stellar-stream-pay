/**
 * Event indexer tests (node:test, no network).
 *
 * The indexer is exercised against a real SQLite database (`:memory:`, or a
 * temp file for the restart test) and a fake RPC object, so the fold, the
 * cursor checkpoint, and the resume path are all covered without a node.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Address, Keypair, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/db.js";
import {
  backfillFromEvents,
  decodeEvent,
  enrichStream,
  pollForward,
  seedFromStorage,
  vestedAmount,
} from "../src/indexer.js";

const SENDER = Keypair.random().publicKey();
const RECEIVER = Keypair.random().publicKey();
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

/** A decoded-event-shaped object, exactly as `decodeEvent` produces it. */
const evt = (kind, over = {}) => ({
  kind,
  stream_id: 0,
  sender: SENDER,
  receiver: RECEIVER,
  token: TOKEN,
  amount: "1000",
  receiver_amount: null,
  timestamp: null,
  start_time: "100",
  end_time: "200",
  cliff_time: "100",
  ledger: 10,
  txHash: "0".repeat(64),
  id: `${kind}-0`,
  ...over,
});

test("folds created/withdraw/cancelled into the streams table", () => {
  const store = openDatabase();
  store.applyEvent(evt("created", { stream_id: 1, id: "e1" }));

  const s1 = store.getStream(1);
  assert.equal(s1.sender, SENDER);
  assert.equal(s1.total_amount, 1000n);
  assert.equal(s1.cliff_time, 100n);
  assert.equal(s1.withdrawn, 0n);
  assert.equal(s1.cancelled, false);

  store.applyEvent(evt("withdraw", { stream_id: 1, amount: "300", receiver_amount: "300", id: "e2" }));
  store.applyEvent(evt("withdraw", { stream_id: 1, amount: "200", receiver_amount: "200", id: "e3" }));
  assert.equal(store.getStream(1).withdrawn, 500n);

  // Cancel settles the vested remainder: withdrawn == frozen accrued.
  store.applyEvent(
    evt("cancelled", { stream_id: 1, amount: "500", receiver_amount: "500", timestamp: "150", id: "e4" }),
  );
  const done = store.getStream(1);
  assert.equal(done.cancelled, true);
  assert.equal(done.withdrawn, 1000n);
  assert.equal(done.cancelled_at, 150n);
  assert.equal(store.countEvents(), 4);
  store.close();
});

test("replaying an event id is idempotent (cursor overlap cannot double-count)", () => {
  const store = openDatabase();
  store.applyEvent(evt("created", { stream_id: 2, id: "dup-1" }));
  store.applyEvent(evt("withdraw", { stream_id: 2, receiver_amount: "100", id: "dup-2" }));
  assert.equal(store.getStream(2).withdrawn, 100n);

  // Same event delivered twice (RPC pages are inclusive at the boundary).
  const again = store.applyEvent(evt("withdraw", { stream_id: 2, receiver_amount: "100", id: "dup-2" }));
  assert.equal(again.inserted, false);
  assert.equal(store.getStream(2).withdrawn, 100n);
  assert.equal(store.countEvents(), 2);
  store.close();
});

test("ignores events for unknown streams defensively", () => {
  const store = openDatabase();
  store.applyEvent(evt("withdraw", { stream_id: 99, receiver_amount: "10", id: "orphan" }));
  assert.equal(store.getStream(99), null);
  store.close();
});

test("decodes a raw RPC event (topics + map value) into JSON-safe fields", () => {
  const raw = {
    id: "evt-1",
    ledger: 100,
    txHash: "0".repeat(64),
    topic: [
      nativeToScVal("stream_event", { type: "symbol" }),
      nativeToScVal("created", { type: "symbol" }),
      nativeToScVal(7, { type: "u64" }),
      new Address(SENDER).toScVal(),
      new Address(RECEIVER).toScVal(),
    ],
    value: nativeToScVal({
      token: TOKEN,
      amount: 1000n,
      receiver_amount: 0n,
      timestamp: 1_700_000_000n,
      start_time: 100n,
      end_time: 200n,
      cliff_time: 150n,
    }),
  };
  const d = decodeEvent(raw);
  assert.equal(d.kind, "created");
  assert.equal(d.stream_id, 7);
  assert.equal(d.amount, "1000");
  assert.equal(d.cliff_time, "150");
  assert.equal(d.timestamp, "1700000000");
  assert.equal(d.start_time, "100");
  assert.equal(d.end_time, "200");
});

test("seeds from a storage scan with live state, not event-derived state", async () => {
  const rawStream = nativeToScVal({
    sender: SENDER,
    receiver: RECEIVER,
    token: TOKEN,
    total_amount: 1000n,
    start_time: 100n,
    end_time: 200n,
    cliff_time: 150n,
    withdrawn: 250n,
    cancelled: false,
    cancelled_at: 0n,
  });
  const counter = nativeToScVal(2, { type: "u64" });
  const rpc = {
    async getContractData(_id, key) {
      const isCounter = scValToNative(key)[0] === "Counter";
      return {
        val: { value: () => ({ val: () => (isCounter ? counter : rawStream) }) },
      };
    },
  };
  const store = openDatabase();
  const { streams } = await seedFromStorage({ rpc, contractId: "C", store });
  assert.equal(streams, 2);
  const s = store.getStream(1);
  assert.equal(s.withdrawn, 250n, "seeding keeps the live withdrawn amount");
  assert.equal(s.cliff_time, 150n);
  store.close();
});

test("backfill checkpoints the cursor and a restart resumes forward from it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stream-index-"));
  const file = join(dir, "index.db");

  const mkRaw = (kind, id, ledger) => ({
    id: `e-${id}`,
    ledger,
    txHash: "0".repeat(64),
    topic: [
      nativeToScVal("stream_event", { type: "symbol" }),
      nativeToScVal(kind, { type: "symbol" }),
      nativeToScVal(id, { type: "u64" }),
      new Address(SENDER).toScVal(),
      new Address(RECEIVER).toScVal(),
    ],
    value: nativeToScVal({
      token: TOKEN,
      amount: kind === "created" ? 1000n : 100n,
      receiver_amount: kind === "created" ? 0n : 100n,
      start_time: 100n,
      end_time: 200n,
      cliff_time: 100n,
    }),
  });
  const pages = [
    { events: [mkRaw("created", 0, 100)], cursor: "c1", latestLedger: 30_000 },
    { events: [mkRaw("created", 1, 30_000)], cursor: "c2", latestLedger: 30_010 },
    { events: [], cursor: "c3", latestLedger: 30_010 },
  ];
  let calls = 0;
  const rpc = {
    async getEvents() {
      return pages[Math.min(calls++, pages.length - 1)];
    },
  };

  const first = openDatabase(file);
  await backfillFromEvents({ rpc, contractId: "C", store: first, startLedger: 1 });
  assert.equal(first.countStreams(), 2);
  assert.equal(first.getCursor(), "c3");
  first.close();

  // Restart: the persisted cursor is the resume point, so the next poll must
  // not fall back to a window scan of the head.
  const reopened = openDatabase(file);
  assert.equal(reopened.getCursor(), "c3", "cursor survives a restart");
  let seenParams = null;
  const pollRpc = {
    async getLatestLedger() {
      throw new Error("should not be called when a cursor exists");
    },
    async getEvents(params) {
      seenParams = params;
      return { events: [], cursor: "c4", latestLedger: 31_000 };
    },
  };
  await pollForward({ rpc: pollRpc, contractId: "C", store: reopened });
  assert.equal(seenParams.cursor, "c3");
  assert.equal(seenParams.startLedger, undefined);
  assert.equal(reopened.getCursor(), "c4");
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test("pollForward broadcasts only newly folded events", async () => {
  const store = openDatabase();
  store.markSeeded();
  // Forward polling always starts from the persisted checkpoint (a warm
  // restart), never from a fresh head window.
  store.setCursor("c0");
  const raw = {
    id: "e-created-9",
    ledger: 100,
    txHash: "0".repeat(64),
    topic: [
      nativeToScVal("stream_event", { type: "symbol" }),
      nativeToScVal("created", { type: "symbol" }),
      nativeToScVal(9, { type: "u64" }),
      new Address(SENDER).toScVal(),
      new Address(RECEIVER).toScVal(),
    ],
    value: nativeToScVal({
      token: TOKEN,
      amount: 1000n,
      receiver_amount: 0n,
      start_time: 100n,
      end_time: 200n,
      cliff_time: 100n,
    }),
  };
  const broadcast = [];
  const rpc = {
    async getEvents() {
      return { events: [raw, raw], cursor: "tail", latestLedger: 100 };
    },
  };
  const n = await pollForward({
    rpc,
    contractId: "C",
    store,
    onEvent: (e) => broadcast.push(e),
  });
  assert.equal(n, 1, "the duplicate in the same page is folded once");
  assert.equal(broadcast.length, 1);
  assert.equal(store.countStreams(), 1);
  assert.equal(store.getMeta("lastPollAt") !== null, true);
  store.close();
});

test("enrichStream mirrors the contract's vesting math and freezes cancelled streams", () => {
  const now = 150n; // mid-stream: 50% of [100, 200]
  const s = {
    id: 0,
    sender: SENDER,
    receiver: RECEIVER,
    token: TOKEN,
    total_amount: 1000n,
    start_time: 100n,
    end_time: 200n,
    cliff_time: 100n,
    withdrawn: 0n,
    cancelled: false,
    cancelled_at: 0n,
  };
  assert.equal(vestedAmount(s.total_amount, s.start_time, s.end_time, now), 500n);
  const e = enrichStream(s, now);
  assert.equal(e.accrued, "500");
  assert.equal(e.withdrawable, "500");
  assert.equal(e.progress, 0.5);

  const e2 = enrichStream({ ...s, withdrawn: 200n }, 999n);
  assert.equal(e2.accrued, "1000");
  assert.equal(e2.withdrawable, "800");
  assert.equal(e2.progress, 1);

  // Cancelled: `cancel` settled on-chain, so nothing remains withdrawable.
  const c = enrichStream({ ...s, withdrawn: 500n, cancelled: true }, 999n);
  assert.equal(c.accrued, "500");
  assert.equal(c.withdrawable, "0");
});

test("enrichStream gates accrual on the cliff without re-basing the schedule", () => {
  const s = {
    id: 1,
    sender: SENDER,
    receiver: RECEIVER,
    token: TOKEN,
    total_amount: 1000n,
    start_time: 100n,
    end_time: 200n,
    cliff_time: 150n,
    withdrawn: 0n,
    cancelled: false,
    cancelled_at: 0n,
  };
  assert.equal(enrichStream(s, 120n).accrued, "0");
  assert.equal(enrichStream(s, 120n).progress, 0);
  assert.equal(enrichStream(s, 150n).accrued, "500");
  assert.equal(enrichStream(s, 175n).accrued, "750");
  assert.equal(enrichStream(s, 999n).accrued, "1000");
  assert.equal(enrichStream(s, 999n).cliff_time, "150");
});
