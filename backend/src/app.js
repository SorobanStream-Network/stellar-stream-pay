/**
 * HTTP API for the stream index.
 *
 * Everything the dashboard reads is served from SQLite (`store`), not from
 * Soroban RPC: the indexer keeps the database current and the API queries it
 * with keyset pagination (`?limit=&cursor=<last id seen>`), which stays cheap
 * as the stream count grows and cannot skip/duplicate rows the way OFFSET can.
 *
 * Request validation is zod (`address`, `limit`, `cursor`), responses are
 * rate-limited per client, and `GET /api/events/stream` is a Server-Sent Events
 * feed for live updates.
 */
import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { enrichStream } from "./indexer.js";

/** A Stellar account id (`G...`, 56 chars, base32). */
const AccountAddress = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "expected a Stellar account id (G...)");

/** Keyset pagination: `cursor` is the last id of the previous page (exclusive). */
const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.coerce.number().int().min(0).optional(),
});

const EventsQuery = PageQuery.extend({
  address: AccountAddress.optional(),
});

const SseQuery = z.object({
  address: AccountAddress.optional(),
});

/** Route params wrapped so validation issues report the `address` field. */
const AddressParams = z.object({ address: AccountAddress });

/** An HTTP error that carries a status and optional field-level issues. */
export class HttpError extends Error {
  constructor(status, message, issues = undefined) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

/** Validate with zod, throwing a 400 {@link HttpError} with readable issues. */
function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid request",
      result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "input",
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/**
 * Build the Express app.
 *
 * `store` must be an open index database (see `db.js`); `hub` an SSE hub (see
 * `sse.js`). `rpc`/`horizon` are optional so tests can run without a network —
 * the account-balance route is skipped when `horizon` is absent.
 */
export function createApp({
  store,
  hub = null,
  contractId = "",
  network = null,
  rpc = null,
  horizon = null,
  now = () => Math.floor(Date.now() / 1000),
  rateLimitOptions = {},
} = {}) {
  if (!store) throw new Error("createApp requires an open store");

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Per-IP rate limiting. The SSE feed holds a connection open for as long as
  // the tab lives, so it is exempt (it would otherwise exhaust the budget just
  // by staying connected).
  const limiter = rateLimit({
    windowMs: rateLimitOptions.windowMs ?? 60_000,
    limit: rateLimitOptions.limit ?? 240,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: (req) => req.path === "/events/stream",
    message: { error: "too many requests — slow down and retry shortly" },
  });
  app.use("/api", limiter);

  /** 503 until the startup backfill has completed at least once. */
  const requireReady = (res) => {
    if (!contractId) {
      res.status(400).json({ error: "STREAM_CONTRACT_ID is not configured on the server." });
      return false;
    }
    if (!store.isSeeded()) {
      res.status(503).json({
        error: "Stream index is still backfilling — retry in a few seconds.",
        reason: store.getMeta("seedError") || null,
      });
      return false;
    }
    return true;
  };

  /** Map a page of streams to the wire shape, adding `nextCursor`. */
  const pageOfStreams = (req, res, rows, limit) => {
    const at = BigInt(now());
    const streams = rows.map((s) => enrichStream(s, at));
    res.json({
      ...(req.params.address ? { address: req.params.address } : {}),
      count: streams.length,
      streams,
      nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
    });
  };

  app.get("/health", (_req, res) => {
    res.json({
      status: store.getMeta("seedError") ? "degraded" : "ok",
      network,
      streamContractId: contractId || null,
      index: store.stats(),
      sseClients: hub?.size ?? 0,
    });
  });

  // Every indexed stream, paginated by ascending id.
  app.get("/api/streams", (req, res) => {
    if (!requireReady(res)) return;
    const { limit, cursor } = parse(PageQuery, req.query);
    pageOfStreams(req, res, store.listStreams({ limit, after: cursor ?? 0 }), limit);
  });

  // Streams where `address` is the sender or the receiver, paginated from the DB.
  app.get("/api/stream/:address", (req, res) => {
    if (!requireReady(res)) return;
    const { address } = parse(AddressParams, req.params);
    const { limit, cursor } = parse(PageQuery, req.query);
    pageOfStreams(
      { params: { address } },
      res,
      store.listByAddress(address, { limit, after: cursor ?? 0 }),
      limit,
    );
  });

  // Persisted lifecycle events (the raw log the index was built from).
  app.get("/api/events", (req, res) => {
    if (!requireReady(res)) return;
    const { limit, cursor, address } = parse(EventsQuery, req.query);
    const events = store.listEvents({ limit, after: cursor ?? 0, address });
    res.json({
      ...(address ? { address } : {}),
      count: events.length,
      events,
      nextCursor: events.length === limit ? events[events.length - 1].seq : null,
    });
  });

  // Live updates. `?address=G...` narrows the feed to one account's streams.
  app.get("/api/events/stream", (req, res) => {
    if (!contractId) {
      res.status(400).json({ error: "STREAM_CONTRACT_ID is not configured on the server." });
      return;
    }
    const { address } = parse(SseQuery, req.query);
    hub.subscribe(res, {
      address: address ?? null,
      hello: {
        contractId,
        network,
        cursor: store.getCursor(),
        streams: store.countStreams(),
      },
    });
  });

  // Classic-account balances (Horizon). Optional: absent in tests.
  if (horizon) {
    app.get("/api/account/:address", async (req, res, next) => {
      try {
        const { address } = parse(AddressParams, req.params);
        const account = await horizon.loadAccount(address);
        res.json({
          id: account.accountId(),
          balances: account.balances.map((b) => ({
            asset: b.asset_type === "native" ? "XLM" : `${b.asset_code}:${b.asset_issuer}`,
            balance: b.balance,
          })),
        });
      } catch (err) {
        if (err instanceof HttpError) return next(err);
        // Horizon throws a 404-shaped object for unknown accounts.
        next(new HttpError(404, `account ${req.params.address} was not found on this network`));
      }
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // eslint-disable-next-line no-unused-vars -- Express identifies error
  // middleware by arity, so the 4th parameter must stay.
  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    if (status >= 500) {
      console.error("[api]", err);
      return res.status(status).json({ error: "internal error" });
    }
    res.status(status).json({
      error: err.message,
      ...(err.issues ? { issues: err.issues } : {}),
    });
  });

  return app;
}
