# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version below tracks the **`stream-core` contract**; the backend and
frontend follow the contract's interface.

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
