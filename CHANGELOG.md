# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version below tracks the **`stream-core` contract**; the backend and
frontend follow the contract's interface.

## [Unreleased]

### Added

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
  error codes (1–19), host/system failures (balance, fees, trustlines, TTL
  expiry), Freighter rejections, and network errors into human-readable
  messages before they reach the UI.
- **Frontend pre-flight validation** — checks Freighter readiness, account
  existence, XLM gas, sender token balance, and a simulated trustline probe for
  the receiver *before* the wallet signing dialog opens.

### Changed

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
