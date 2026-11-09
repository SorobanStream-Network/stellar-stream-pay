/**
 * SQLite persistence for the stream index.
 *
 * Why SQLite: Soroban RPC only retains contract events for a bounded ledger
 * window (`getEvents` cannot reach arbitrary history), so an indexer that keeps
 * state only in memory loses every stream it has not re-scanned after a
 * restart. Folding events into a local database, and checkpointing the forward
 * cursor after each page, makes restarts cheap and exact: we resume from the
 * stored cursor and only lose the window the process was down for — which the
 * startup backfill closes.
 *
 * Storage notes:
 *  - `i128` amounts can exceed SQLite's signed 64-bit INTEGER, so amounts are
 *    stored as decimal TEXT and all arithmetic happens in BigInt here.
 *  - Times (unix seconds) and ledger sequences fit in INTEGER.
 *  - `events.event_id` is UNIQUE, so replaying an overlapping page (RPC pages
 *    are inclusive at the boundary) is idempotent.
 */
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS streams (
  id             INTEGER PRIMARY KEY,
  sender         TEXT    NOT NULL,
  receiver       TEXT    NOT NULL,
  token          TEXT    NOT NULL,
  total_amount   TEXT    NOT NULL,
  start_time     INTEGER NOT NULL,
  end_time       INTEGER NOT NULL,
  cliff_time     INTEGER NOT NULL,
  withdrawn      TEXT    NOT NULL DEFAULT '0',
  cancelled      INTEGER NOT NULL DEFAULT 0,
  cancelled_at   INTEGER NOT NULL DEFAULT 0,
  created_ledger INTEGER,
  updated_ledger INTEGER
);
CREATE INDEX IF NOT EXISTS streams_sender   ON streams(sender, id);
CREATE INDEX IF NOT EXISTS streams_receiver ON streams(receiver, id);

CREATE TABLE IF NOT EXISTS splits (
  root_id      INTEGER PRIMARY KEY,
  sender       TEXT NOT NULL,
  token        TEXT NOT NULL,
  member_ids   TEXT NOT NULL,
  total_amount TEXT
);

CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id  TEXT    NOT NULL UNIQUE,
  kind      TEXT    NOT NULL,
  stream_id INTEGER,
  root_id   INTEGER,
  sender    TEXT,
  receiver  TEXT,
  ledger    INTEGER NOT NULL,
  tx_hash   TEXT,
  payload   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ledger   ON events(ledger, seq);
CREATE INDEX IF NOT EXISTS events_sender   ON events(sender, seq);
CREATE INDEX IF NOT EXISTS events_receiver ON events(receiver, seq);
`;

/** Coerce a nullable value to BigInt (RPC/DB values arrive as string or number). */
const big = (value, fallback = 0n) => (value == null ? fallback : BigInt(value));

/** Whole seconds from a BigInt/string/number, saturating negatives at 0. */
const seconds = (value) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
};

/** Normalize a DB row into the stream shape `enrichStream` consumes. */
function rowToStream(row) {
  return {
    id: row.id,
    sender: row.sender,
    receiver: row.receiver,
    token: row.token,
    total_amount: BigInt(row.total_amount),
    start_time: BigInt(row.start_time),
    end_time: BigInt(row.end_time),
    cliff_time: BigInt(row.cliff_time),
    withdrawn: BigInt(row.withdrawn),
    cancelled: row.cancelled === 1,
    cancelled_at: BigInt(row.cancelled_at),
  };
}

/**
 * Open (or create) the index database.
 *
 * `file` defaults to `:memory:` — that is what the tests use. Pass a path to
 * persist (WAL is enabled for file databases so a reader never blocks the
 * indexer's writes).
 */
export function openDatabase(file = ":memory:") {
  const db = new Database(file);
  if (file !== ":memory:") db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const sql = {
    getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
    insertEvent: db.prepare(`
      INSERT OR IGNORE INTO events
        (event_id, kind, stream_id, root_id, sender, receiver, ledger, tx_hash, payload)
      VALUES
        (@event_id, @kind, @stream_id, @root_id, @sender, @receiver, @ledger, @tx_hash, @payload)`),
    getStream: db.prepare("SELECT * FROM streams WHERE id = ?"),
    insertStream: db.prepare(`
      INSERT INTO streams
        (id, sender, receiver, token, total_amount, start_time, end_time, cliff_time,
         withdrawn, cancelled, cancelled_at, created_ledger, updated_ledger)
      VALUES
        (@id, @sender, @receiver, @token, @total_amount, @start_time, @end_time, @cliff_time,
         @withdrawn, @cancelled, @cancelled_at, @created_ledger, @updated_ledger)
      ON CONFLICT(id) DO NOTHING`),
    updateSettlement: db.prepare(
      "UPDATE streams SET withdrawn = ?, cancelled = ?, cancelled_at = ?, updated_ledger = ? WHERE id = ?",
    ),
    listStreams: db.prepare("SELECT * FROM streams WHERE id > ? ORDER BY id ASC LIMIT ?"),
    listByAddress: db.prepare(
      "SELECT * FROM streams WHERE (sender = ? OR receiver = ?) AND id > ? ORDER BY id ASC LIMIT ?",
    ),
    countStreams: db.prepare("SELECT COUNT(*) AS n FROM streams"),
    countEvents: db.prepare("SELECT COUNT(*) AS n FROM events"),
    listEvents: db.prepare(
      "SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?",
    ),
    listEventsByAddress: db.prepare(
      "SELECT * FROM events WHERE (sender = ? OR receiver = ?) AND seq > ? ORDER BY seq ASC LIMIT ?",
    ),
    upsertSplit: db.prepare(`
      INSERT INTO splits (root_id, sender, token, member_ids, total_amount)
      VALUES (@root_id, @sender, @token, @member_ids, @total_amount)
      ON CONFLICT(root_id) DO NOTHING`),
    getSplit: db.prepare("SELECT * FROM splits WHERE root_id = ?"),
  };

  /**
   * Fold one decoded event into the stream table, inside a transaction.
   *
   * Idempotent: the `events` insert is `OR IGNORE` on the unique event id, and a
   * duplicate short-circuits before any stream mutation, so replaying an
   * overlapping RPC page can never double-count a withdrawal.
   */
  const applyEvent = db.transaction((event) => {
    const info = sql.insertEvent.run({
      event_id: String(event.id ?? `${event.txHash}:${event.kind}:${event.stream_id ?? event.root_id ?? 0}:${event.ledger}`),
      kind: event.kind,
      stream_id: event.stream_id ?? null,
      root_id: event.root_id ?? null,
      sender: event.sender ?? null,
      receiver: event.receiver ?? null,
      ledger: seconds(event.ledger),
      tx_hash: event.txHash ?? null,
      payload: JSON.stringify({ ...event, ledger: undefined, txHash: undefined, id: undefined }),
    });
    if (info.changes === 0) return { inserted: false, event };

    if (event.kind === "created") {
      const start = seconds(event.start_time);
      sql.insertStream.run({
        id: Number(event.stream_id),
        sender: event.sender,
        receiver: event.receiver,
        token: event.token,
        total_amount: big(event.amount).toString(),
        start_time: start,
        end_time: seconds(event.end_time),
        // Pre-upgrade events carry no cliff: a stream with no cliff has
        // `cliff_time == start_time`, so the default is exact.
        cliff_time: event.cliff_time == null ? start : seconds(event.cliff_time),
        withdrawn: "0",
        cancelled: 0,
        cancelled_at: 0,
        created_ledger: seconds(event.ledger),
        updated_ledger: seconds(event.ledger),
      });
    } else if (event.kind === "withdraw" || event.kind === "cancelled") {
      const row = sql.getStream.get(Number(event.stream_id));
      if (row) {
        const flow = big(event.receiver_amount ?? event.amount);
        const settled = event.kind === "cancelled";
        sql.updateSettlement.run(
          (BigInt(row.withdrawn) + flow).toString(),
          settled ? 1 : row.cancelled,
          settled ? seconds(event.timestamp ?? row.cancelled_at) : row.cancelled_at,
          seconds(event.ledger),
          row.id,
        );
      }
    } else if (event.kind === "split_created") {
      sql.upsertSplit.run({
        root_id: Number(event.root_id),
        sender: event.sender,
        token: event.token,
        member_ids: JSON.stringify(event.member_ids ?? []),
        total_amount: event.total_amount == null ? null : String(event.total_amount),
      });
    }
    return { inserted: true, event };
  });

  const eventRow = (row) => ({
    seq: row.seq,
    kind: row.kind,
    stream_id: row.stream_id,
    root_id: row.root_id,
    sender: row.sender,
    receiver: row.receiver,
    ledger: row.ledger,
    txHash: row.tx_hash,
    ...JSON.parse(row.payload),
  });

  const store = {
    /** Raw better-sqlite3 handle (tests / migrations). */
    raw: db,
    close: () => db.close(),

    getMeta(key) {
      const row = sql.getMeta.get(key);
      return row ? row.value : null;
    },
    setMeta(key, value) {
      if (value === undefined || value === null) return;
      sql.setMeta.run(String(key), String(value));
    },

    /** Forward-pagination cursor checkpoint, or `null` before the first poll. */
    getCursor: () => store.getMeta("cursor"),
    setCursor(cursor) {
      store.setMeta("cursor", cursor);
    },
    /** Whether the startup backfill has completed at least once. */
    isSeeded: () => store.getMeta("seeded") === "1",
    markSeeded() {
      store.setMeta("seeded", "1");
    },

    applyEvent,

    /**
     * Insert a complete stream row from a storage scan.
     *
     * Seeding reads live contract state (including `withdrawn`), so it cannot
     * go through the event fold — a synthetic `created` event would reset
     * history. `ON CONFLICT DO NOTHING` keeps it idempotent against a stream
     * the event backfill already produced.
     */
    seedStream(stream) {
      sql.insertStream.run({
        id: Number(stream.id),
        sender: stream.sender,
        receiver: stream.receiver,
        token: stream.token,
        total_amount: big(stream.total_amount).toString(),
        start_time: seconds(stream.start_time),
        end_time: seconds(stream.end_time),
        cliff_time:
          stream.cliff_time == null ? seconds(stream.start_time) : seconds(stream.cliff_time),
        withdrawn: big(stream.withdrawn).toString(),
        cancelled: stream.cancelled ? 1 : 0,
        cancelled_at: seconds(stream.cancelled_at),
        created_ledger: null,
        updated_ledger: null,
      });
    },

    getStream(id) {
      const row = sql.getStream.get(Number(id));
      return row ? rowToStream(row) : null;
    },

    /** All streams, keyset-paginated by id (`after` is exclusive). */
    listStreams({ limit = 50, after = 0 } = {}) {
      return sql.listStreams.all(Number(after), Number(limit)).map(rowToStream);
    },

    /** Streams where `address` is sender or receiver, keyset-paginated by id. */
    listByAddress(address, { limit = 50, after = 0 } = {}) {
      return sql
        .listByAddress.all(address, address, Number(after), Number(limit))
        .map(rowToStream);
    },

    countStreams: () => sql.countStreams.get().n,
    countEvents: () => sql.countEvents.get().n,

    /** Persisted events, newest page by `seq` (keyset, `after` exclusive). */
    listEvents({ limit = 50, after = 0, address } = {}) {
      const rows = address
        ? sql.listEventsByAddress.all(address, address, Number(after), Number(limit))
        : sql.listEvents.all(Number(after), Number(limit));
      return rows.map(eventRow);
    },

    getSplit(rootId) {
      const row = sql.getSplit.get(Number(rootId));
      if (!row) return null;
      return {
        root_id: row.root_id,
        sender: row.sender,
        token: row.token,
        member_ids: JSON.parse(row.member_ids),
        total_amount: row.total_amount == null ? null : BigInt(row.total_amount),
      };
    },

    stats() {
      return {
        streams: store.countStreams(),
        events: store.countEvents(),
        cursor: store.getCursor(),
        seeded: store.isSeeded(),
        lastPollAt: store.getMeta("lastPollAt"),
      };
    },
  };

  return store;
}
