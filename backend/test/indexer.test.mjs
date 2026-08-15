/**
 * Event-indexer tests (node:test, zero new deps).
 *
 * `src/indexer.js` folds the contract's `created` / `withdraw` / `cancelled`
 * / `split_created` events into an in-memory index that the `/api/streams` and
 * `/api/stream/:address` routes serve from — replacing the per-request
 * `0..count` storage scan. These tests pin the fold semantics against the
 * contract's behavior (withdraw accumulates; cancel freezes `withdrawn` at the
 * vested-at-freeze amount; missing/archived entries are skipped) plus the
 * storage-seed, event-backfill, forward-poll, decode, and enrich paths.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Address, Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  backfillFromEvents,
  createStreamIndex,
  decodeEvent,
  enrichStream,
  foldEvent,
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
  start_time: "100",
  end_time: "200",
  ...over,
});

test("folds created/withdraw/cancelled into final stream state", () => {
  const index = createStreamIndex();
  foldEvent(index, evt("created", { stream_id: 1 }));
  const s1 = index.streams.get(1);
  assert.equal(s1.sender, SENDER);
  assert.equal(s1.receiver, RECEIVER);
  assert.equal(s1.total_amount, 1000n);
  assert.equal(s1.start_time, 100n);
  assert.equal(s1.end_time, 200n);
  assert.equal(s1.withdrawn, 0n);
  assert.equal(s1.cancelled, false);

  // Two withdraws accumulate (contract: receiver pulls the accrued delta).
  foldEvent(index, evt("withdraw", { stream_id: 1, amount: "300", receiver_amount: "300" }));
  foldEvent(index, evt("withdraw", { stream_id: 1, amount: "200", receiver_amount: "200" }));
  assert.equal(index.streams.get(1).withdrawn, 500n);
  assert.equal(index.counts.withdraw, 2);

  // Cancel pays the vested-but-unwithdrawn remainder (receiver_amount). The
  // contract sets withdrawn = accrued on cancel, so the folded total lands on
  // the exact vested-at-freeze amount.
  foldEvent(index, evt("cancelled", { stream_id: 1, amount: "500", receiver_amount: "500" }));
  const done = index.streams.get(1);
  assert.equal(done.cancelled, true);
  assert.equal(done.withdrawn, 1000n, "withdrawn == frozen accrued after cancel");
  assert.equal(index.counts.cancelled, 1);
});

test("cancel without prior withdraw freezes at the full vested amount", () => {
  const index = createStreamIndex();
  foldEvent(index, evt("created", { stream_id: 2, amount: "1000" }));
  // Cancel mid-stream: accrued 500, nothing withdrawn yet.
  foldEvent(index, evt("cancelled", { stream_id: 2, amount: "500", receiver_amount: "500" }));
  const s = index.streams.get(2);
  assert.equal(s.cancelled, true);
  assert.equal(s.withdrawn, 500n);
});

test("folds split_created into group membership", () => {
  const index = createStreamIndex();
  foldEvent(index, {
    kind: "split_created",
    root_id: 3,
    sender: SENDER,
    token: TOKEN,
    member_ids: [3, 4, 5],
    total_amount: "3000",
  });
  const g = index.splits.get(3);
  assert.deepEqual(g.member_ids, [3, 4, 5]);
  assert.equal(g.total_amount, 3000n);
  assert.equal(index.counts.split_created, 1);
});

test("ignores unknown kinds and events for unknown stream ids defensively", () => {
  const index = createStreamIndex();
  foldEvent(index, { kind: "mystery", stream_id: 1 });
  foldEvent(index, evt("withdraw", { stream_id: 99, receiver_amount: "10" })); // no created yet
  assert.equal(index.streams.size, 0);
  assert.equal(index.counts.mystery, 1);
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
      start_time: 100n,
      end_time: 200n,
    }),
  };
  const d = decodeEvent(raw);
  assert.equal(d.kind, "created");
  assert.equal(d.stream_id, 7);
  assert.equal(d.sender, SENDER);
  assert.equal(d.receiver, RECEIVER);
  assert.equal(d.amount, "1000");
  assert.equal(d.receiver_amount, "0");
  assert.equal(d.start_time, "100");
  assert.equal(d.end_time, "200");
});

test("seeds from a storage scan (counter + per-stream getContractData)", async () => {
  // Storage round-trip via nativeToScVal -> scValToNative.
  const rawStream = nativeToScVal({
    sender: SENDER,
    receiver: RECEIVER,
    token: TOKEN,
    total_amount: 1000n,
    start_time: 100n,
    end_time: 200n,
    withdrawn: 250n,
    cancelled: false,
    cancelled_at: 0n,
  });
  const counter = nativeToScVal(2, { type: "u64" });
  const rpc = {
    async getContractData(_id, key, _durability) {
      const isCounter = scValToNative(key)[0] === "Counter";
      return {
        val: {
          value: () => ({
            val: () => (isCounter ? counter : rawStream),
          }),
        },
      };
    },
  };
  const index = createStreamIndex();
  await seedFromStorage({ rpc, contractId: "C", index });
  assert.equal(index.seeded, true);
  assert.equal(index.streams.size, 2);
  const s = index.streams.get(1);
  assert.equal(s.sender, SENDER);
  assert.equal(s.total_amount, 1000n);
  assert.equal(s.withdrawn, 250n);
});

test("backfills from events across ledger windows and keeps the forward cursor", async () => {
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
  const index = createStreamIndex();
  await backfillFromEvents({ rpc, contractId: "C", index, startLedger: 1 });
  assert.equal(index.seeded, true);
  assert.equal(index.streams.size, 2);
  assert.equal(index.cursor, "c3");
  assert.ok(calls >= 3, "walked multiple windows to reach the head");
});

test("pollForward folds only the new events from the cursor", async () => {
  const raw = (kind, id) => ({
    id: `e-${id}`,
    ledger: 100,
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
      amount: kind === "created" ? 1000n : 50n,
      receiver_amount: kind === "created" ? 0n : 50n,
      start_time: 100n,
      end_time: 200n,
    }),
  });
  const rpc = {
    async getLatestLedger() {
      return { sequence: 100 };
    },
    async getEvents(params) {
      if (params.cursor === "tail") return { events: [], cursor: "tail", latestLedger: 100 };
      return { events: [raw("created", 9)], cursor: "tail", latestLedger: 100 };
    },
  };
  const index = createStreamIndex();
  index.seeded = true; // already backfilled
  const n = await pollForward({ rpc, contractId: "C", index });
  assert.equal(n, 1);
  assert.equal(index.streams.size, 1);
  assert.equal(index.cursor, "tail");
  assert.ok(index.lastPollAt);
});

test("enrichStream mirrors the contract vesting math and freezes cancelled streams", () => {
  const now = 150n; // mid-stream: 50% of [100, 200]
  const s = {
    id: 0,
    sender: SENDER,
    receiver: RECEIVER,
    token: TOKEN,
    total_amount: 1000n,
    start_time: 100n,
    end_time: 200n,
    withdrawn: 0n,
    cancelled: false,
    cancelled_at: 0n,
  };
  assert.equal(vestedAmount(s.total_amount, s.start_time, s.end_time, now), 500n);
  const e = enrichStream(s, now);
  assert.equal(e.accrued, "500");
  assert.equal(e.withdrawable, "500");
  assert.equal(e.progress, 0.5);

  // Fully vested: accrued == total, withdrawable == total - withdrawn.
  const e2 = enrichStream({ ...s, withdrawn: 200n }, 999n);
  assert.equal(e2.accrued, "1000");
  assert.equal(e2.withdrawable, "800");
  assert.equal(e2.progress, 1);

  // Cancelled: frozen at the folded withdrawn amount, withdrawable 0 (the
  // contract rejects post-cancel withdraws with `StreamCancelled`).
  const c = enrichStream({ ...s, withdrawn: 500n, cancelled: true }, 999n);
  assert.equal(c.accrued, "500");
  assert.equal(c.withdrawable, "0");
  assert.equal(c.cancelled, true);
});
