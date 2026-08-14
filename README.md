<div align="center">

# 💸 StellarStream-Pay

**Continuous, linearly-vesting streaming payments on [Stellar](https://stellar.org) / [Soroban](https://developers.stellar.org/docs/smart-contracts).**

*Stream salaries, grants, and unlocks token-by-token, in real time — on-chain,
self-custodial, and denominated in any SEP-41 asset (including SAC-wrapped XLM,
USDC, EURC, …).*

![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)
![Soroban SDK](https://img.shields.io/badge/soroban--sdk-27.0.6-7c5cff)
![Rust](https://img.shields.io/badge/rust-1.84%2B-orange.svg)
![Network](https://img.shields.io/badge/network-testnet-3bd0c9)

</div>

---

## What is a "stream"?

A **stream** is a time-release payment. A sender locks a token amount for a fixed
duration, and the receiver can withdraw the pro-rata amount that has accrued so
far — on demand, at any time, without further involvement from the sender.

```text
                  min(t, end) − start
   accrued(t) = total × ─────────────────
                        end − start

   withdrawable(t) = accrued(t) − withdrawn
```

- **Sender** → `create_stream(...)` locks funds in the vault and starts the clock.
- **Receiver** → `withdraw(...)` pulls the accrued, un-withdrawn amount at any time.
- **Sender or receiver** → `cancel(...)` stops the stream, pays out the vested
  remainder to the receiver, and refunds the unvested remainder to the sender.

Every mutating call enforces `require_auth()` on the acting party, and all token
movement flows through the standard [SEP-41](https://developers.stellar.org/docs/tokens/token-interface)
`token::Client` interface — so streams work identically for Stellar Asset
Contracts (SAC) and custom tokens.

## Architecture

```text
                          ┌─────────────────────────────┐
                          │       Employer (sender)     │
                          │     Freighter wallet (G…)   │
                          └──────────────┬──────────────┘
                                         │  create_stream(token, amount, duration)
                                         │  require_auth(sender) · locks tokens
                                         ▼
                          ┌─────────────────────────────┐
                          │        Soroban Vault        │
                          │    StreamingContract (C…)   │
                          │                             │
                          │  stream = {                 │
                          │    sender, receiver, token, │
                          │    total, start, end,       │
                          │    withdrawn, cancelled     │
                          │  }                          │
                          └───────┬──────────────┬──────┘
                                  │              │
        withdraw(accrued)         │              │  cancel(refund)
        require_auth(receiver)    │              │  require_auth(sender or receiver)
                                  ▼              ▼
               ┌────────────────────────┐   ┌────────────────────────┐
               │    Receiver (payee)    │   │   Employer (refund)    │
               │  withdraws on demand   │   │  unvested remainder    │
               └────────────────────────┘   └────────────────────────┘

                    ── roadmap (not yet implemented) ──
   Employer ─► Vault ─► Payer ─► Split / Dependency streams ─► Sub-payees
```

### How the pieces fit together

- **Contract** (`contracts/core/`) — holds locked funds and enforces the linear vesting
  schedule. Emits `created`, `withdrawn`, and `cancelled` events for indexers.
- **Backend** (`backend/`) — Express API that reads contract storage directly via
  Soroban RPC (`getContractData`) and classic balances via Horizon, serving the
  frontend with decorated stream data (`accrued`, `withdrawable`, `progress`).
- **Frontend** (`frontend/`) — Freighter wallet integration; builds, simulates,
  assembles, signs, and submits `create_stream` / `withdraw` / `cancel`
  transactions with `@stellar/stellar-sdk`.

## Features

- 🔐 **Soroban smart contract** — `#![no_std]`, strict `require_auth()` on every
  actor, check-effects-interactions ordering, overflow-checked arithmetic, and a
  complete unit/integration test suite with authorization-tree assertions.
- 🧊 **Frozen core, composable extensions** — `stream-core` (API v1) is small,
  auditable, and immutable; future capabilities (splits, schedules, payroll) ship
  as separate contracts that *compose* the core rather than extending it.
- 🧪 **Property-based invariant tests** — `proptest` randomizes the vesting math
  across thousands of cases, and a settlement-invariant test proves no tokens are
  created or destroyed across create/withdraw/cancel scenarios.
- ⛓️ **SAC & SEP-41 native** — streams any token through the standard token
  interface; no separate mint/clawback/admin logic.
- 🗂️ **Node indexer / API** — reads live stream state from Soroban RPC and account
  balances from Horizon, with computed accrual/withdrawable/progress.
- ⚛️ **React + Freighter DApp** — connect wallet, create streams, withdraw accrued
  amounts, and cancel streams from a clean dashboard.
- 📡 **Lifecycle events** — `created` / `withdrawn` / `cancelled` topics for
  event-based indexing and notifications.

## Repository layout

```text
stellar-stream-pay/
├── contracts/              # Rust / Soroban contracts (Cargo workspace)
│   ├── Cargo.toml          #   workspace root + release profile
│   └── core/               #   frozen stream-core primitive (API v1)
│       ├── src/lib.rs      #     create_stream, withdraw, cancel + views
│       ├── src/test.rs     #     unit, integration, property & invariant tests
│       ├── Cargo.toml      #     stream-core package (soroban-sdk, proptest)
│       └── test_snapshots/ #     committed SDK snapshot tests
├── backend/                # Node.js / Express indexer & API
│   ├── src/index.js        #   reads stream state from Soroban RPC + Horizon
│   └── Dockerfile          #   container image
├── frontend/               # React / Vite DApp with Freighter wallet
│   ├── src/App.tsx         #   dashboard: view/manage streams, trigger actions
│   ├── src/lib/soroban.ts  #   wallet + transaction helpers
│   └── Dockerfile          #   multi-stage build + nginx serve
├── docs/                   # architecture & design docs
├── .github/workflows/      # CI (contract, backend, frontend, PR title lint)
├── docker-compose.yml      # local orchestration (backend + frontend)
├── CONTRIBUTING.md         # development workflow & conventions
├── CODE_OF_CONDUCT.md      # community guidelines
├── CHANGELOG.md            # version history
├── SECURITY.md             # vulnerability disclosure policy
└── README.md
```

## Prerequisites

| Tool | Why | Version |
|------|-----|---------|
| [Rust](https://rustup.rs) | build the contract | 1.84+ |
| [`stellar-cli`](https://developers.stellar.org/docs/tools/developer-tools/cli) | build/deploy contracts | latest |
| [Node.js](https://nodejs.org) | backend + frontend | 20+ (22 recommended) |
| [Freighter](https://freighter.app) | browser wallet for signing | latest |

Install `stellar-cli`:

```bash
cargo install stellar-cli --locked
```

Verify:

```bash
rustc --version      # >= 1.84
stellar --version
node --version       # >= 20
```

## Quick start

### 1. Build, test & deploy the contract

```bash
cd contracts/core

# Compile to ../target/wasm32v1-none/release/stream_core.wasm.
# Always use `stellar contract build` (never plain `cargo build`).
stellar contract build

# Run the vesting-math + integration + property-based invariant tests.
cargo test
```

Upload (install) the Wasm, then deploy an instance on Testnet:

```bash
# Install the compiled Wasm; prints a hex wasm hash.
stellar contract upload \
  --wasm ../target/wasm32v1-none/release/stream_core.wasm \
  --network testnet

# Deploy an instance from that hash; prints the contract id (C...).
stellar contract deploy \
  --wasm-hash <WASM_HASH> \
  --network testnet
```

Copy the contract id — the backend and frontend both need it.

### 2. Run the backend

```bash
cd backend
cp .env.example .env          # set STREAM_CONTRACT_ID to your contract id
npm install
npm start                     # or: npm run dev (watch mode)
```

The server listens on `http://localhost:4000`:

| Endpoint | Description |
|----------|-------------|
| `GET /health` | RPC connectivity + network info |
| `GET /api/stream/:address` | Streams where `:address` is sender or receiver (Soroban RPC) |
| `GET /api/account/:address` | Classic/SAC balances for an address (Horizon) |
| `GET /api/events` | Lifecycle events (`created` / `withdraw` / `cancelled`) for the contract |

```bash
curl http://localhost:4000/api/stream/GBVZ...YOUR...ADDRESS
```

### 3. Run the frontend

```bash
cd frontend
cp .env.example .env          # set VITE_CONTRACT_ID to your contract id
npm install
npm run dev                   # http://localhost:5173
```

With the backend running (`VITE_BACKEND_URL`):

1. Click **Connect Freighter**.
2. **Create a stream** — enter a receiver, the SAC/token contract id, the amount
   in base units, and a duration in seconds.
3. Streams where you are the receiver show a **Withdraw** button once something
   has vested; streams you sent show a **Cancel** button.

### 4. Run with Docker

Both services ship container images plus a `docker-compose.yml`:

```bash
export STREAM_CONTRACT_ID=C...   # backend
VITE_CONTRACT_ID=C... docker compose up --build
```

Serves the backend on `http://localhost:4000` and the frontend (with
`VITE_CONTRACT_ID` baked in at build time) on `http://localhost:8080`. All env
vars have Testnet defaults — see the `.env.example` files.

## Contract API

| Function | Auth | Description |
|----------|------|-------------|
| `create_stream(sender, receiver, token, amount, duration_seconds) -> u64` | `sender` | Locks `amount` (base units) from `sender` and starts a stream. |
| `withdraw(receiver, stream_id) -> i128` | `receiver` | Pays out the currently accrued (un-withdrawn) amount. |
| `cancel(caller, stream_id) -> i128` | `sender` or `receiver` | Settles the stream: pays the vested remainder to the receiver and refunds the unvested remainder to the sender. |
| `get_stream(stream_id) -> Stream` | — | Read a stream. |
| `streamed_amount(stream_id) -> i128` | — | Current vested amount (pro-rata). |
| `get_withdrawable(stream_id) -> i128` | — | Amount currently available to withdraw. |
| `get_stream_count() -> u64` | — | Total streams ever created. |
| `version() -> u32` | — | Pinned core API version. |

### Storage layout (for indexers)

- Streams: **persistent** storage, keyed by `DataKey::Stream(u64)`.
- Stream counter: **persistent** storage, keyed by `DataKey::Counter`.

The backend reads both directly via RPC `getContractData`.

## Security

- **Authorization** — `create_stream`, `withdraw`, and `cancel` each call
  `require_auth()` on the acting party; token pulls/pushes flow through the
  SEP-41 `token::Client`, which enforces its own auth.
- **Check-effects-interactions** — stream state is updated *before* external token
  calls, and arithmetic overflow traps (rather than wraps) via `overflow-checks = true`.
- **SAC compatibility** — transfers use the standard SEP-41 `token::Client`, which
  works for SAC-wrapped native assets and custom tokens alike. The admin-only
  `token::StellarAssetClient` (mint/clawback) is intentionally unused.
- **Frontend signing** — transactions are simulated + assembled via
  `prepareTransaction` (so auth entries and footprints are correct) before Freighter
  signs; the app never touches private keys.
- **Indexer scaling** — the backend scans stream ids `0..count` for simplicity. For
  large fleets, index the contract's `created` / `withdrawn` / `cancelled` events
  instead (see `StreamEvent`).

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## Networks

Defaults target **Testnet**. For Mainnet, switch `RPC_URL`, `HORIZON_URL`,
`VITE_RPC_URL`, and `VITE_NETWORK_PASSPHRASE`
(`Public Global Stellar Network ; September 2015`) and deploy with
`--network mainnet`.

## Roadmap

- [x] Core linearly-vesting stream contract (`create` / `withdraw` / `cancel` + views + events)
- [x] Unit, integration, and authorization-tree tests with committed snapshots
- [x] Property-based invariant tests (proptest) + settlement-invariant suite
- [x] `stream-core` v1 extracted to `contracts/core/` as a frozen, composable workspace member
- [x] Express indexer / API (Soroban RPC + Horizon)
- [x] React + Freighter dashboard (connect, create, withdraw, cancel)
- [ ] **Split streams** — fan one stream out to multiple receivers
- [ ] **Dependency streams** — payer → sub-payee chains (multi-tier payroll)
- [ ] Event-based indexing (replace the id-scan with `created`/`withdrawn`/`cancelled` events)
- [ ] Token metadata display (symbol + decimals) in the dashboard
- [ ] Relayer / gasless withdrawals for receivers
- [ ] Mainnet deployment + third-party audit

## Contributing

- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow, testing, and commit/PR conventions.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — community guidelines.
- [docs/architecture.md](docs/architecture.md) — system architecture (C4-style diagrams).
- [CHANGELOG.md](CHANGELOG.md) — version history.

## License

[Apache-2.0](LICENSE) © StellarStream-Pay contributors.
