# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version below tracks the **`stream-core` contract**; the backend and
frontend follow the contract's interface.

## [Unreleased]

### Added

- **Scheduled starts and cliffs (`stream-core` v5)** — a new
  `create_stream_scheduled(sender, receiver, token, amount, duration, start_time,
  cliff_seconds)` opens a stream at a future `start_time` with an optional
  cliff; nothing is withdrawable before `start_time + cliff_seconds`, and the
  cliff gates the unlock **without re-basing** the schedule (the pre-cliff
  portion unlocks at once when it passes). `create_stream` stays as a 5-arg
  alias (start now, no cliff), so existing callers keep working. New errors
  `StartTimeInPast` (#21, with a two-minute `START_TIME_GRACE_SECONDS`
  tolerance for inclusion lag) and `InvalidCliff` (#22); `Stream` now carries
  `start_time` / `cliff_time` and event data carries `timestamp` /
  `start_time` / `cliff_time` / `end_time`.
- **API layer** — `backend/src/app.js` exposes the API as a `createApp()`
  factory: zod validation for addresses (`G…`/56-char) and pagination params,
  keyset pagination (`?limit=1..100&cursor=`) on `/api/streams` and
  `/api/stream/:address`, an `express-rate-limit` default of 240 req/min, and a
  structured `503` until the initial seed completes. `startServer()` is exported
  so the entrypoint is testable without side effects.
- **SSE live updates** — `/api/events/stream` (with an optional address filter)
  broadcasts newly folded lifecycle events with 20 s heartbeats; it is exempt
  from rate limiting so a held connection cannot exhaust the budget.
- **Backend container for the index** — the image installs a native toolchain to
  build `better-sqlite3`, declares the `/data` volume
  (`DATABASE_PATH=/data/streams.db`), and healthchecks `/health`;
  `docker-compose.yml` mounts the named `backend-data` volume so the ledger
  cursor survives `up --build`.
- **Token metadata + human input** — the dashboard reads `symbol()` and
  `decimals()` from the token contract by simulation (cached, with a
  7-decimal/short-address fallback), takes the amount in the token's own units
  (`parseUnits`, BigInt-exact), and offers a duration + unit picker and
  `datetime-local` start/cliff pickers instead of raw seconds.
- **Live accrued balances** — one 1 s clock in the app drives per-card accrual,
  withdrawable, and progress from the stream's
  `start_time`/`cliff_time`/`end_time`, taking `max(local, API)` so ledger drift
  can never show less than the settled value.
- **Stellar Wallets Kit** — replaced the Freighter-only integration with
  `@creit.tech/stellar-wallets-kit` (Freighter, xBull, Albedo, Lobstr, Rabet,
  Hana, Klever, …), pinning the signing address so a wallet switched mid-flow
  fails loudly instead of signing as the wrong account.
- **Network-mismatch detection** — both the RPC passphrase and the wallet's
  connected network are compared with `VITE_NETWORK_PASSPHRASE`; a mismatch
  shows an explicit banner and blocks writes.
- **Frontend tests** — Vitest covers the accrual maths (`lib/accrual.ts`) and
  the formatting/parsing helpers (`lib/format.ts`): 20 tests, run in CI via
  `npm test`.
- **CI runs the JavaScript tests** — the backend job now runs `npm test`
  (indexer, API, SSE, bootstrap) and the frontend job runs `npm test` alongside
  `tsc -b && vite build`, both on Node 22 to match the runtime the images ship
  on.
- **Batched keeper entrypoint (`bump_many`)** — `stream-core` v4 adds a
  permissionless `bump_many(Vec<u64>)` that re-arms up to `MAX_BUMP_BATCH`
  (32) streams plus the shared entries in ONE transaction, so a relayer
  serving a large fleet pays one tx per batch per pass instead of one per
  stream. Atomic like `bump` (`StreamNotFound` reverts the whole batch) and
  bounded by the new `BatchTooLarge` error (#20). `bump` is refactored onto a
  shared `bump_stream_entry` helper so the two can never drift apart.
- **Keeper batching + fallback** — `backend/src/keeper.js` now submits due
  streams via `bump_many` chunked by `KEEPER_BUMP_BATCH` (default 4, clamped
  to the contract cap), and falls back to per-stream `bump` calls when a
  batch fails (e.g. the deployed contract predates `bump_many` or the batch
  exceeds the per-tx footprint), so streams are never left un-re-armed.
- **Event-based backend indexer** — `backend/src/indexer.js` folds the
  contract's `created`/`withdrawn`/`cancelled` (+ `split_created`) events into
  SQLite (`backend/src/db.js`) instead of an in-memory index: event ids are
  `UNIQUE`, so replaying a page after a crash is a no-op, and a ledger cursor is
  checkpointed in `meta` after every page, so the first boot backfills once
  (storage scan, or pure event backfill from `INDEX_START_LEDGER`) and every
  later boot **resumes from the cursor** — surviving Soroban RPC's limited event
  retention. `/api/streams` and `/api/stream/:address` are keyset-paginated
  queries over the folded state instead of scanning storage ids `0..count` per
  request; cancelled streams freeze at the folded vested-at-freeze amount, and
  the raw event stream stays queryable via `/api/events`. Amounts are stored as
  decimal `TEXT` because `i128` exceeds 64 bits. `DATABASE_PATH` /
  `INDEX_POLL_MS` / `INDEX_START_LEDGER` env vars.
- **Contract overflow hardening** — the release profile now sets
  `overflow-checks = true` (contract `Cargo.toml`), making the documented
  "overflow traps, never wraps" guarantee true in release wasm builds.
- **Keeper monitoring** — every pass emits a structured one-line JSON status
  (`ok`, `streams`/`due`/`covered`/`instanceBumped`, `failed`, `durationMs`)
  for log shippers, and the scheduler serves `GET /health` (liveness) and
  `GET /status` (last pass result + errors, `degraded` after a failure) on
  `KEEPER_HEALTH_PORT` (default 4300). The compose `keeper` service gets a
  `healthcheck` against `/health`.
- **Prometheus metrics endpoint** — `GET /metrics` on the keeper's health
  port serves Prometheus text-format exposition for Grafana alerting:
  monotonic counters (`stream_core_keeper_bumps_total`,
  `_batches_total`, `_failures_total`, `_passes_total`,
  `_pass_failures_total`) and last-pass gauges (`_last_pass_timestamp_seconds`,
  `_last_pass_ok`, `_last_pass_duration_seconds`, `_streams`, `_due_streams`,
  `_covered_streams`, `_instance_bumped`, `_up`). Dry-run passes never
  inflate the work counters; a fresh process emits zeroed series so alerting
  works from the first scrape.
- **TTL keeper relayer** — `backend/src/keeper.js` schedules the
  permissionless `bump` / `bump_many` / `bump_instance` calls from a funded
  keeper account: it re-arms the contract instance + code lease on every
  pass and re-arms per-stream leases only for entries below the TTL
  threshold (default 30 days), so gas spend tracks need. Runs as a
  long-lived scheduler, `--once` for cron, or a `keeper` service in
  docker-compose; unit-tested with `node:test` (no new dependencies).
- **Contract lease extension (TTL timebomb fix)** — `stream-core` v3 now
  re-arms the contract **instance + Wasm code** TTL (a separate ledger entry
  from the persistent data) on the constructor, every lifecycle write
  (create/withdraw/cancel/split/pause), and via keepers. A new permissionless
  `bump_instance` entrypoint lets keepers extend an idle contract's lease even
  when no streams exist, so the vault can never be archived while holding funds.
- **Frontend error decoding** — `decodeSorobanError` maps raw Soroban contract
  error codes (1–22), host/system failures (balance, fees, trustlines, TTL
  expiry), wallet rejections, and network errors into human-readable messages
  before they reach the UI.
- **Frontend pre-flight validation** — checks Freighter readiness, account
  existence, XLM gas, sender token balance, and a simulated trustline probe for
  the receiver *before* the wallet signing dialog opens.

### Changed

- Contract error codes #21 (`StartTimeInPast`) and #22 (`InvalidCliff`) are
  decoded into human-readable messages in the dashboard, alongside the existing
  enum mapping.
- `create_stream` on the frontend now sends the v1 call when no start/cliff is
  set and `create_stream_scheduled` otherwise; a relative start delay is
  resolved to an absolute `start_time` at transaction-build time so the
  simulation and the submitted footprint agree.
- Backend `/api/stream/:address` and `/api/events` are now served from SQLite
  rather than Soroban RPC per request; responses gained `count` / `nextCursor`,
  and the `/health` payload reports index stats (`streams`, `events`, `cursor`,
  `seeded`).
- `@stellar/freighter-api` dropped as a direct dependency — the wallets kit owns
  the Freighter adapter now.
- Node floor raised to 22 (`backend/package.json` `engines`, CI, Docker image) so
  the `better-sqlite3` native module is built for the runtime it ships on.
- Frontend transactions are now prepared (simulated + assembled) with decoded
  failure messages and pre-flighted per action; the SDK exposes permissionless
  `bumpStreamTtl` / `bumpStreamsTtl` / `bumpContractTtl` keeper helpers.
- Docs: added the modular-architecture refactoring blueprint
  (`docs/architecture-refactor.md`).

## [1.0.0] - 2026-08-14

### Added

- **Frozen `stream-core` v1** — extracted the contract into `contracts/core/` as
  a Cargo workspace member, pinned the public API, and added a `version()` view
  plus a `STREAM_CORE_API_VERSION` constant.
- **Property-based invariant tests** — a `proptest` suite covering the vesting
  math (bounded, monotonic, exact floor division, exact endpoints, split
  distribution) and a settlement-invariant test proving token conservation
  across create/withdraw/cancel scenarios.

### Changed

- Package renamed `stellar-stream-pay` → `stream-core`.

## [0.1.0] - 2026-08-13

### Added

- Soroban `#![no_std]` streaming contract: `create_stream`, `withdraw`,
  `cancel`, `streamed_amount`, read views, and lifecycle events.
- Express indexer / API — storage reads plus a `getEvents`-based `/api/events`
  endpoint for `created` / `withdraw` / `cancelled` events.
- React + Freighter dashboard — connect, create streams, withdraw, cancel.
- Security policy, Soroban CI workflow, and README.

### Fixed

- Backend storage reads (`LedgerEntryData` union accessors) and cancelled-stream
  accounting.
- Contract event indexing — topic layout (`#[contractevent]` name at topic[0]),
  `getEvents` SegmentMatcher format, and the default ledger window.

### Security

- Fee-on-transfer token rejection (`TokenTransferMismatch`) and persistent
  storage TTL management.
