/**
 * Event-based stream indexer (SQLite-backed).
 *
 * Soroban RPC has no websocket push and only retains events for a bounded
 * ledger window, so the indexer:
 *
 *   1. **Seeds once** — either by scanning contract storage for `0..count`
 *      (exact, the default) or by walking `getEvents` forward from
 *      `INDEX_START_LEDGER` (best-effort, for contracts whose history predates
 *      RPC retention).
 *   2. **Persists** every folded event and the forward `cursor` in SQLite, so a
 *      restart resumes from the last ledger page it saw instead of re-reading
 *      history it can no longer reach.
 *   3. **Polls forward** from that cursor, folding `created` / `withdraw` /
 *      `cancelled` / `split_created` events into the stream table and pushing
 *      each new one to the SSE hub.
 *
 * The fold mirrors the contract:
 *
 *   created       -> insert the stream (withdrawn 0, cancelled false)
 *   withdraw      -> withdrawn += receiver_amount
 *   cancelled     -> withdrawn += receiver_amount, cancelled = true
 *                    (the contract sets withdrawn = accrued, so the folded
 *                    total is the exact vested-at-freeze amount)
 *   split_created -> record group membership
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
// Event query + decode (raw layer shared by backfill, polling, /api/events)
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
    timestamp: value.timestamp != null ? String(value.timestamp) : null,
    start_time: value.start_time != null ? String(value.start_time) : null,
    end_time: value.end_time != null ? String(value.end_time) : null,
    cliff_time: value.cliff_time != null ? String(value.cliff_time) : null,
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
// Backfill + forward polling (all state lands in SQLite)
// ---------------------------------------------------------------------------

/**
 * Seed the index once from a storage scan (ids `0..count` via getContractData).
 * Used when there is no persisted cursor and `INDEX_START_LEDGER` is unset: it
 * is a one-time backfill, not a per-request scan. Throws on RPC failure so the
 * caller can retry.
 */
export async function seedFromStorage({ rpc, contractId, store }) {
  const counterRes = await rpc.getContractData(contractId, COUNTER_KEY, "persistent");
  const counterScv = counterRes.val?.value()?.val();
  const count = counterScv ? Number(scValToNative(counterScv)) : 0;
  let inserted = 0;
  for (let id = 0; id < count; id++) {
    const res = await rpc.getContractData(contractId, streamKey(id), "persistent");
    const scv = res.val?.value()?.val();
    if (!scv) continue; // archived/missing entry
    const raw = scValToNative(scv);
    store.seedStream({
      id,
      sender: raw.sender,
      receiver: raw.receiver,
      token: raw.token,
      total_amount: raw.total_amount,
      start_time: raw.start_time,
      end_time: raw.end_time,
      // Pre-upgrade entries have no `cliff_time` (== start_time).
      cliff_time: raw.cliff_time ?? raw.start_time,
      withdrawn: raw.withdrawn,
      cancelled: raw.cancelled,
      cancelled_at: raw.cancelled_at,
    });
    inserted += 1;
  }
  return { streams: inserted };
}

/**
 * Pure event backfill: walk getEvents forward from `startLedger` in ~10k-ledger
 * windows (getEvents scans a bounded range per request and caps results at 100
 * events), folding everything into the store and checkpointing the cursor as it
 * goes. Best-effort: a window with more than 100 matching events is partially
 * captured — the default storage-seed mode is exact. Bounded by `maxPages`.
 */
export async function backfillFromEvents({ rpc, contractId, store, startLedger, maxPages = 5000 }) {
  const WINDOW = 10_000;
  let start = startLedger;
  let folded = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await queryContractEvents({ rpc, contractId, startLedger: start, limit: 100 });
    for (const e of res.events) {
      if (store.applyEvent(e).inserted) folded += 1;
    }
    if (res.cursor) store.setCursor(res.cursor);
    if (start > res.latestLedger) break; // walked past the head — done
    start += WINDOW;
  }
  return { folded };
}

/**
 * One forward poll from the persisted cursor, folding whatever is new and
 * pushing each newly folded event to `onEvent` (the SSE hub). Returns the number
 * of events folded.
 */
export async function pollForward({ rpc, contractId, store, onEvent }) {
  const res = await queryContractEvents({
    rpc,
    contractId,
    cursor: store.getCursor() ?? undefined,
    limit: 100,
  });
  let folded = 0;
  for (const e of res.events) {
    if (!store.applyEvent(e).inserted) continue; // replay of an overlapping page
    folded += 1;
    onEvent?.(e);
  }
  if (res.cursor) store.setCursor(res.cursor);
  store.setMeta("lastPollAt", new Date().toISOString());
  return folded;
}

/**
 * Start the indexer: resume from the persisted cursor when there is one,
 * otherwise seed (storage scan by default, or event backfill from
 * `startLedger`), then poll forward every `pollMs`.
 *
 * Failures are logged and retried — a broken poll never crashes the API. The
 * returned `stop()` clears the timer.
 */
export function startIndexer({
  rpc,
  contractId,
  store,
  startLedger = 0,
  pollMs = 15_000,
  logger = console,
  onEvent = () => {},
}) {
  // Guard against concurrent seeds (e.g. a poll firing while the startup
  // backfill is still running) by memoizing the in-flight promise.
  let seeding = null;
  const seed = () => {
    if (!seeding) {
      seeding = (async () => {
        try {
          if (store.getCursor()) {
            // Warm restart: the DB already holds everything up to `cursor`.
            logger.log("[indexer] resuming from persisted cursor");
          } else if (startLedger > 0) {
            const { folded } = await backfillFromEvents({ rpc, contractId, store, startLedger });
            logger.log(`[indexer] backfilled ${folded} event(s) from ledger ${startLedger}`);
          } else {
            const { streams } = await seedFromStorage({ rpc, contractId, store });
            logger.log(`[indexer] seeded ${streams} stream(s) from storage scan`);
          }
          store.markSeeded();
          store.setMeta("seedError", "");
          store.setMeta("seededAt", new Date().toISOString());
          logger.log(`[indexer] ready — ${store.countStreams()} stream(s) indexed`);
        } catch (err) {
          store.setMeta("seedError", err.message);
          logger.warn(`[indexer] seed failed: ${err.message} — retrying`);
        } finally {
          seeding = null;
        }
      })();
    }
    return seeding;
  };

  const poll = async () => {
    if (!store.isSeeded()) {
      await seed(); // keep retrying until the backfill lands
      return;
    }
    try {
      const n = await pollForward({ rpc, contractId, store, onEvent });
      if (n > 0) {
        logger.log(`[indexer] folded ${n} new event(s) — ${store.countStreams()} stream(s) tracked`);
      }
    } catch (err) {
      logger.warn(`[indexer] poll failed: ${err.message} — will retry`);
    }
  };

  seed(); // fire-and-forget; routes 503 until seeded (see app.js)
  const timer = setInterval(poll, pollMs);
  return { store, stop: () => clearInterval(timer) };
}

// ---------------------------------------------------------------------------
// Enrichment (mirrors the contract's vesting math)
// ---------------------------------------------------------------------------

/**
 * Mirror the contract's linear vesting formula (all BigInt).
 *
 * `cliff` gates the unlock without re-basing the schedule: nothing accrues
 * before `cliff`, and from `cliff` on the ordinary `start`→`end` line applies,
 * so the pre-cliff portion unlocks at once. It defaults to `start`, which is
 * exactly `create_stream`'s no-cliff behaviour.
 */
export function vestedAmount(total, start, end, now, cliff = start) {
  if (now < cliff) return 0n;
  if (now <= start) return 0n;
  const t = now < end ? now : end;
  const elapsed = t - start;
  const duration = end - start;
  if (duration === 0n) return total;
  return (total * elapsed) / duration;
}

/**
 * Decorate a stored stream with computed accrual/withdrawable/progress.
 * For a cancelled stream vesting is frozen: `cancel` settles eagerly, so the
 * stored `withdrawn` is the vested-at-freeze amount and nothing is withdrawable.
 */
export function enrichStream(s, now) {
  const cliff = s.cliff_time ?? s.start_time;
  const accrued = s.cancelled
    ? s.withdrawn
    : vestedAmount(s.total_amount, s.start_time, s.end_time, now, cliff);
  const withdrawable = s.cancelled ? 0n : accrued - s.withdrawn;
  const duration = s.end_time - s.start_time;
  const progress = s.cancelled
    ? s.total_amount === 0n
      ? 1
      : Number(s.withdrawn) / Number(s.total_amount)
    : duration === 0n
      ? 1
      : Number(now < cliff ? 0n : now < s.end_time ? now - s.start_time : duration) /
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
    cliff_time: cliff.toString(),
    cancelled: s.cancelled,
    progress: Math.min(Math.max(progress, 0), 1),
  };
}
