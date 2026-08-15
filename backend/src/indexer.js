/**
 * Event-based stream indexer for the StellarStream-Pay backend.
 *
 * The contract publishes a `StreamEvent` (`created` / `withdraw` / `cancelled`)
 * and a `SplitEvent` (`split_created`) on every state change. Soroban RPC has
 * no websocket push, so indexers poll `getEvents` and fold each event into
 * their own state — this module does exactly that, in memory, and serves the
 * `/api/streams` / `/api/stream/:address` routes from the folded state instead
 * of scanning storage ids `0..count` on every request.
 *
 * Streams are never deleted, so the fold is append-only state updates:
 *
 *   created    -> { sender, receiver, token, total, start, end, withdrawn: 0,
 *                   cancelled: false }
 *   withdraw   -> withdrawn += receiver_amount   (== amount for single streams)
 *   cancelled  -> cancelled = true; withdrawn += receiver_amount
 *                 (the contract sets withdrawn = accrued on cancel, so after
 *                 the fold `withdrawn` is the vested-at-freeze amount — the
 *                 frozen accrued for a cancelled stream)
 *   split_created -> { root_id, sender, token, member_ids, total_amount }
 *
 * Backfill modes (env, see index.js):
 *   * default            — seed once from a storage scan (one batch of
 *                          getContractData), then maintain via events forward.
 *   * INDEX_START_LEDGER — pure event backfill from that ledger (windowed
 *                          getEvents walk), then maintain via events forward.
 *
 * Both modes are cursor-based going forward, so a stream created while the
 * process is down is picked up on the next poll.
 */
import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

// Storage layout mirror (must match contracts/core/src/lib.rs `DataKey`).
// A `#[contracttype]` enum serializes as a Vec with a leading Symbol
// discriminant. Pinned by the contract's
// `data_key_encoding_matches_backend_expectations` test.
const COUNTER_KEY = xdr.ScVal.scvVec([nativeToScVal("Counter", { type: "symbol" })]);
const streamKey = (id) =>
  xdr.ScVal.scvVec([
    nativeToScVal("Stream", { type: "symbol" }),
    nativeToScVal(id, { type: "u64" }),
  ]);

// ---------------------------------------------------------------------------
// Event query + decode (the raw layer shared by backfill, polling, and the
// `/api/events` route).
// ---------------------------------------------------------------------------

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
const SPLIT_EVENT_TOPICS_FILTER = [
  nativeToScVal("split_event", { type: "symbol" }).toXDR("base64"),
  nativeToScVal("split_created", { type: "symbol" }).toXDR("base64"),
  "**",
];

/** Decode one raw RPC event into a plain, JSON-safe object. */
export function decodeEvent(e) {
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
 * Query the contract's lifecycle events since `startLedger` (inclusive) or
 * from `cursor`, returning at most `limit` (≤ 100) matching events plus the
 * pagination cursor for the next page.
 */
export async function queryContractEvents({ rpc, contractId, startLedger, cursor, limit = 100 }) {
  // Soroban RPC's `getEvents` scans a bounded number of ledgers per request
  // (~10k), so a wide default range can silently return no results even when
  // matching events exist. Default to a recent ~1000-ledger window (~83 min)
  // when neither a cursor nor an explicit startLedger is supplied.
  const params = {
    filters: [
      {
        type: "contract",
        contractIds: [contractId],
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

// ---------------------------------------------------------------------------
// Index state + fold
// ---------------------------------------------------------------------------

/** Fresh, empty index state. */
export function createStreamIndex() {
  return {
    streams: new Map(), // id -> folded stream state (BigInt amounts/times)
    splits: new Map(), // root_id -> split group metadata
    cursor: null, // forward getEvents cursor
    seeded: false,
    seedError: null,
    lastPollAt: null,
    counts: { created: 0, withdraw: 0, cancelled: 0, split_created: 0 },
  };
}

/**
 * Fold one decoded event into the index. Idempotent per stream id: streams are
 * only ever created once, and withdraw/cancelled events accumulate onto the
 * existing entry. Unknown kinds / unknown stream ids are ignored defensively.
 */
export function foldEvent(index, e) {
  index.counts[e.kind] = (index.counts[e.kind] ?? 0) + 1;
  if (e.kind === "created") {
    index.streams.set(e.stream_id, {
      id: e.stream_id,
      sender: e.sender,
      receiver: e.receiver,
      token: e.token,
      total_amount: BigInt(e.amount),
      start_time: BigInt(e.start_time),
      end_time: BigInt(e.end_time),
      withdrawn: 0n,
      cancelled: false,
      cancelled_at: 0n,
    });
  } else if (e.kind === "withdraw") {
    const s = index.streams.get(e.stream_id);
    if (s) s.withdrawn += BigInt(e.receiver_amount ?? e.amount ?? 0);
  } else if (e.kind === "cancelled") {
    const s = index.streams.get(e.stream_id);
    if (s) {
      s.cancelled = true;
      // Contract sets withdrawn = accrued on cancel; receiver_amount is the
      // vested-but-unwithdrawn remainder paid out, so this lands on the exact
      // frozen accrued amount.
      s.withdrawn += BigInt(e.receiver_amount ?? 0);
    }
  } else if (e.kind === "split_created") {
    index.splits.set(e.root_id, {
      root_id: e.root_id,
      sender: e.sender,
      token: e.token,
      member_ids: e.member_ids,
      total_amount: e.total_amount != null ? BigInt(e.total_amount) : null,
    });
  }
}

// ---------------------------------------------------------------------------
// Backfill + forward polling
// ---------------------------------------------------------------------------

/**
 * Seed the index once from a storage scan (ids `0..count` via getContractData).
 * Used when `INDEX_START_LEDGER` is unset: it is a one-time backfill, not the
 * per-request scan the event index replaces. Throws on RPC failure so the
 * caller can retry.
 */
export async function seedFromStorage({ rpc, contractId, index }) {
  const counterRes = await rpc.getContractData(contractId, COUNTER_KEY, "persistent");
  const counterScv = counterRes.val?.value()?.val();
  const count = counterScv ? Number(scValToNative(counterScv)) : 0;
  for (let id = 0; id < count; id++) {
    const res = await rpc.getContractData(contractId, streamKey(id), "persistent");
    const scv = res.val?.value()?.val();
    if (!scv) continue; // archived/missing entry
    const raw = scValToNative(scv);
    index.streams.set(id, {
      id,
      sender: raw.sender,
      receiver: raw.receiver,
      token: raw.token,
      total_amount: raw.total_amount,
      start_time: raw.start_time,
      end_time: raw.end_time,
      withdrawn: raw.withdrawn,
      cancelled: raw.cancelled,
      cancelled_at: raw.cancelled_at,
    });
    index.counts.created += 1;
  }
  index.seeded = true;
}

/**
 * Pure event backfill: walk getEvents forward from `startLedger` in ~10k-ledger
 * windows (getEvents scans a bounded range per request and caps results at 100
 * events), folding everything into the index. Stops once the window start
 * passes the RPC's latest ledger. Used when `INDEX_START_LEDGER` is set;
 * best-effort (a window with more than 100 matching events is partially
 * captured — the default storage-seed mode is exact). Bounded by `maxPages`.
 */
export async function backfillFromEvents({ rpc, contractId, index, startLedger, maxPages = 5000 }) {
  const WINDOW = 10_000;
  let start = startLedger;
  for (let page = 0; page < maxPages; page++) {
    const res = await queryContractEvents({ rpc, contractId, startLedger: start, limit: 100 });
    for (const e of res.events) foldEvent(index, e);
    if (res.cursor) index.cursor = res.cursor;
    if (start > res.latestLedger) break; // walked past the head — done
    start += WINDOW;
  }
  index.seeded = true;
}

/** One forward poll from the stored cursor; folds whatever is new. */
export async function pollForward({ rpc, contractId, index }) {
  const res = await queryContractEvents({ rpc, contractId, cursor: index.cursor ?? undefined, limit: 100 });
  for (const e of res.events) foldEvent(index, e);
  if (res.cursor) index.cursor = res.cursor;
  index.lastPollAt = new Date().toISOString();
  return res.events.length;
}

/**
 * Start the indexer: seed once (storage scan by default, or event backfill
 * from `startLedger` when > 0), then poll forward every `pollMs`. Failures are
 * logged and retried — a broken poll never crashes the API. Returns
 * `{ index, stop }` so the caller can shut the loop down (tests, graceful
 * shutdown).
 */
export function startIndexer({
  rpc,
  contractId,
  index = createStreamIndex(),
  startLedger = 0,
  pollMs = 15_000,
  logger = console,
}) {
  // Guard against concurrent seeds (e.g. a poll firing while the startup
  // backfill is still running) by memoizing the in-flight promise.
  let seeding = null;
  const seed = () => {
    if (!seeding) {
      seeding = (async () => {
        try {
          if (startLedger > 0) {
            await backfillFromEvents({ rpc, contractId, index, startLedger });
          } else {
            await seedFromStorage({ rpc, contractId, index });
          }
          index.seeded = true;
          index.seedError = null;
          logger.log(
            `[indexer] seeded ${index.streams.size} stream(s) from ${startLedger > 0 ? `ledger ${startLedger}` : "storage scan"}`,
          );
        } catch (err) {
          index.seedError = err.message;
          logger.warn(`[indexer] seed failed: ${err.message} — retrying`);
        } finally {
          seeding = null;
        }
      })();
    }
    return seeding;
  };

  const poll = async () => {
    if (!index.seeded) {
      await seed(); // keep retrying until the backfill lands
      return;
    }
    try {
      const n = await pollForward({ rpc, contractId, index });
      if (n > 0) {
        logger.log(`[indexer] folded ${n} new event(s) — ${index.streams.size} stream(s) tracked`);
      }
    } catch (err) {
      logger.warn(`[indexer] poll failed: ${err.message} — will retry`);
    }
  };

  seed(); // fire-and-forget; routes 503 until seeded (see index.js)
  const timer = setInterval(poll, pollMs);
  return { index, stop: () => clearInterval(timer) };
}

// ---------------------------------------------------------------------------
// Enrichment (mirrors the contract's vesting math + the old scan endpoint)
// ---------------------------------------------------------------------------

/** Mirror the contract's linear vesting formula (all BigInt). */
export function vestedAmount(total, start, end, now) {
  if (now <= start) return 0n;
  const t = now < end ? now : end;
  const elapsed = t - start;
  const duration = end - start;
  if (duration === 0n) return total;
  return (total * elapsed) / duration;
}

/**
 * Decorate a folded index stream with computed accrual/withdrawable/progress,
 * matching the response shape the frontend already consumes from the scan
 * endpoint. For a cancelled stream, vesting is frozen: the folded `withdrawn`
 * IS the vested-at-freeze amount, so accrued == withdrawn and withdrawable
 * is 0 (the contract rejects post-cancel withdraws with `StreamCancelled`).
 */
export function enrichStream(s, now) {
  const accrued = s.cancelled
    ? s.withdrawn
    : vestedAmount(s.total_amount, s.start_time, s.end_time, now);
  const withdrawable = s.cancelled ? 0n : accrued - s.withdrawn;
  const duration = s.end_time - s.start_time;
  // Progress is elapsed/duration while active; for a cancelled stream the
  // folded `withdrawn` is the vested-at-freeze amount, so withdrawn/total is
  // the exact frozen progress.
  const progress = s.cancelled
    ? s.total_amount === 0n
      ? 1
      : Number(s.withdrawn) / Number(s.total_amount)
    : duration === 0n
      ? 1
      : Number(now <= s.start_time ? 0n : now < s.end_time ? now - s.start_time : duration) /
          Number(duration);

  return {
    id: s.id,
    sender: s.sender,
    receiver: s.receiver,
    token: s.token,
    total_amount: s.total_amount.toString(),
    withdrawn: s.withdrawn.toString(),
    accrued: accrued.toString(),
    withdrawable: withdrawable.toString(),
    start_time: s.start_time.toString(),
    end_time: s.end_time.toString(),
    cancelled: s.cancelled,
    progress: Math.min(Math.max(progress, 0), 1),
  };
}
