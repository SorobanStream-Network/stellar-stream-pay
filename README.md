<div align="center">

# 💸 StellarStream-Pay

**Continuous, linearly-vesting streaming payments on [Stellar](https://stellar.org) / [Soroban](https://developers.stellar.org/docs/smart-contracts).**

*Stream salaries, grants, and unlocks token-by-token, in real time — on-chain,
self-custodial, and denominated in any SEP-41 asset (including SAC-wrapped XLM,
USDC, EURC, …).*

![License](https://img.shields.io/badge/license-MIT-blue.svg)
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

> Full C4-style system diagrams (context, containers, key flows) live in
> [docs/architecture.md](docs/architecture.md).

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
- **Backend** (`backend/`) — Express API that maintains an in-memory index of
  stream state from the contract's `created`/`withdrawn`/`cancelled` events
  (seed + `getEvents` poll; see `backend/src/indexer.js`), plus Horizon classic
  balances, serving the frontend with decorated stream data (`accrued`,
  `withdrawable`, `progress`).
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
- 🔋 **Rent-bumped leases** — persistent entries, the contract instance, and the
  Wasm code all have their TTL re-armed to the network maximum on every
  lifecycle write and via permissionless keepers (`bump` / `bump_many` /
  `bump_instance`), so
  long-running streams and an idle vault are never archived.
- 🛡️ **Pre-flight + decoded errors** — every wallet action is validated (wallet
  ready, gas, token balance, receiver trustline) *before* the Freighter dialog,
  and raw Soroban `HostError`/contract codes are decoded into human-readable
  messages.

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
│   ├── src/lib/stellar/    #   wallet, rpc, tx, error-decoding, pre-flight helpers
│   ├── src/lib/contracts/  #   stream-core client (invoke + TTL keepers)
│   └── Dockerfile          #   multi-stage build + nginx serve
├── docs/                   # architecture & design docs
│   ├── architecture.md     #   C4 system design
│   └── architecture-refactor.md  #   modular /sdk decoupling blueprint
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

### 5. Run the TTL keeper (relayer)

`stream-core` v4's permissionless `bump` / `bump_many` / `bump_instance`
entrypoints re-arm the contract instance, Wasm code, and stream entries so
they are never archived while holding funds — but someone has to call them.
`backend/src/keeper.js` is a scheduled relayer that does exactly that:

- every pass sends `bump_instance()` once (re-arms the instance + code +
  admin/pause config + id counter),
- reads every stream entry's remaining TTL via RPC and sends `bump_many([ids])`
  — chunked into `KEEPER_BUMP_BATCH`-sized batches (default 4) — only for
  streams below the threshold (default 30 days), so a fleet pays one tx per
  batch per pass and gas spend tracks need. If a batch fails (the deployed
  contract predates `bump_many`, or the batch exceeds the per-tx footprint)
  it falls back to per-stream `bump` calls, so nothing is ever left un-re-armed.

It needs a **funded keeper account** — any account works, the calls only pay
gas. Run it as a long-lived process, or once per cron tick:

```bash
KEEPER_SECRET=S... npm run keeper                # scheduler (daily by default)
KEEPER_SECRET=S... npm run keeper:once           # single pass, for cron
KEEPER_SECRET=S... npm run keeper -- --dry-run   # plan only, sends nothing
```

Or as a Compose service (enabled by setting `KEEPER_SECRET`):

```bash
KEEPER_SECRET=S... docker compose up -d keeper
```

Tune with `KEEPER_INTERVAL_MIN` (pass cadence, default 1440 = daily),
`KEEPER_TTL_THRESHOLD` (bump streams below this remaining TTL, in ledgers —
518,400 ledgers ≈ 30 days), `KEEPER_BUMP_BATCH` (stream ids per `bump_many`
call, clamped to the contract's cap of 32; default 4), and
`NETWORK_PASSPHRASE`. See `backend/.env.example` for all variables.

#### Monitoring the keeper

Every pass emits one machine-parseable JSON line on stdout, so log shippers
(Loki, Datadog, ELK) can alert on it directly:

```json
{"event":"keeper_pass","ts":"…","ok":true,"streams":2,"due":2,"covered":2,"instanceBumped":true,"dryRun":false,"failed":[],"durationMs":123}
```

Alert when `ok` is false, `failed` is non-empty, or `covered < due`.

In scheduler mode the keeper also serves a tiny health endpoint
(`KEEPER_HEALTH_PORT`, default 4300; `0` disables):

- `GET /health` — liveness: the process is up.
- `GET /status` — last pass result (`ok`, counts, failures, `durationMs`),
  `nextPassInSec`, and `lastError` when a pass failed outright. The endpoint
  reports `"degraded"` after a failed pass.
- `GET /metrics` — Prometheus text-format exposition for scrapers
  (Prometheus, Grafana, VictoriaMetrics): monotonic counters
  (`stream_core_keeper_passes_total`, `_pass_failures_total`,
  `_bumps_total`, `_batches_total`, `_failures_total`) and last-pass gauges
  (`_last_pass_timestamp_seconds`, `_last_pass_ok`,
  `_last_pass_duration_seconds`, `_streams`, `_due_streams`,
  `_covered_streams`, `_instance_bumped`, `_up`). Counters accumulate across
  passes; gauges reflect the most recent pass. A fresh process emits zeroed
  series so alerting rules work from the first scrape.

`docker compose up -d keeper` runs a `healthcheck` against `/health`, so
`docker compose ps` shows the keeper's health. For k8s readiness probes, set
`KEEPER_HEALTH_HOST=0.0.0.0`.

**Grafana alerting.** Point a Prometheus scrape at
`http://<keeper-host>:4300/metrics` (publish `KEEPER_HEALTH_PORT` on the
container, or scrape the host directly) and alert on:

- `stream_core_keeper_last_pass_ok == 0` — the most recent pass failed;
- `increase(stream_core_keeper_failures_total[1h]) > 0` — actions are failing;
- a stalled keeper: `increase(stream_core_keeper_bumps_total[7d]) == 0` while
  `stream_core_keeper_due_streams > 0` — streams are expiring and nothing is
  re-arming them;
- liveness: `up{job="stream-core-keeper"} == 0` after scraping the job.

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
| `bump(stream_id)` | — | Permissionless keeper: re-arms the stream entry's TTL lease (and the instance/code lease). |
| `bump_many(stream_ids)` | — | Permissionless keeper, batched: re-arms several streams (≤ `MAX_BUMP_BATCH` = 32) in one transaction; atomic — a missing id reverts the whole batch. |
| `bump_instance()` | — | Permissionless keeper: re-arms the contract instance + code TTL so an idle vault is never archived. |

### Storage layout (for indexers)

- Streams: **persistent** storage, keyed by `DataKey::Stream(u64)`.
- Stream counter: **persistent** storage, keyed by `DataKey::Counter`.

The backend reads both directly via RPC `getContractData`.

## Security

- **Authorization** — `create_stream`, `withdraw`, and `cancel` each call
  `require_auth()` on the acting party; token pulls/pushes flow through the
  SEP-41 `token::Client`, which enforces its own auth.
- **Input guards** — `InvalidDuration` rejects `duration_seconds == 0` *before*
  any storage write (no divide-by-zero in vesting math); `InvalidAmount` rejects
  non-positive amounts; `InvalidParties` rejects sender == receiver; a missing
  stream id returns `StreamNotFound` and a second `withdraw` on a fully-drawn
  stream returns `NothingToWithdraw` / `StreamCancelled` — clean `Error` codes,
  never panics.
- **Check-effects-interactions** — stream state is updated *before* external token
  calls, and arithmetic overflow traps (rather than wraps) via
  `overflow-checks = true` in the release profile (contract `Cargo.toml`).
- **Circuit breaker (pause)** — the deploy-time constructor binds a single,
  never-re-settable admin address. `pause`/`unpause` (admin-authed) gate NEW
  stream creation only; `withdraw` and `cancel` never consult the flag, so
  receivers keep unconditional access to already-vested funds during a pause.
- **SAC compatibility** — transfers use the standard SEP-41 `token::Client`, which
  works for SAC-wrapped native assets and custom tokens alike. The admin-only
  `token::StellarAssetClient` (mint/clawback) is intentionally unused.
- **Frontend signing** — transactions are simulated + assembled via
  `prepareTransaction` (so auth entries and footprints are correct) before Freighter
  signs; the app never touches private keys.
- **Pre-flight validation** — wallet readiness, gas, token balance, and receiver
  trustlines are checked before the wallet dialog; simulation and submission
  errors are decoded into readable messages (`decodeSorobanError`).
- **Rent bumping** — `create`/`withdraw`/`cancel`/`bump`/`bump_many`/`bump_instance` extend
  the persistent entries *and* the contract instance/code TTL to the network
  maximum, so neither streams nor the vault are archived mid-term.
- **Indexer scaling** — the backend maintains an in-memory index of stream state
  by seeding once and polling the contract's `created` / `withdrawn` / `cancelled`
  events (`getEvents`) forward, so `/api/streams` and `/api/stream/:address` are
  served from the index instead of scanning storage ids `0..count` per request.

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## Networks

Defaults target **Testnet**. For Mainnet, switch `RPC_URL`, `HORIZON_URL`,
`VITE_RPC_URL`, `VITE_HORIZON_URL` (pre-flight balance/trustline checks must
point at the same network as `VITE_RPC_URL`), and `VITE_NETWORK_PASSPHRASE`
(`Public Global Stellar Network ; September 2015`) and deploy with
`--network mainnet`. `VITE_MIN_GAS_XLM` is optional (defaults to 1 XLM).

## Roadmap

- [x] Core linearly-vesting stream contract (`create` / `withdraw` / `cancel` + views + events)
- [x] Unit, integration, and authorization-tree tests with committed snapshots
- [x] Property-based invariant tests (proptest) + settlement-invariant suite
- [x] `stream-core` v1 extracted to `contracts/core/` as a frozen, composable workspace member
- [x] Express indexer / API (Soroban RPC + Horizon)
- [x] React + Freighter dashboard (connect, create, withdraw, cancel)
- [x] **Split streams** — fan one stream out to multiple receivers (`create_split_stream` / `_bps` / `_pct`, `cancel_split`, `get_split`)
- [ ] **Dependency streams** — payer → sub-payee chains (multi-tier payroll)
- [x] Event-based indexing — backend folds `created`/`withdrawn`/`cancelled` (+ split) events into an in-memory index (`/api/streams`, `/api/stream/:address`) instead of the per-request id-scan
- [x] TTL keeper relayer — permissionless `bump`/`bump_many`/`bump_instance` on a schedule, with pass status + Prometheus metrics
- [ ] Token metadata display (symbol + decimals) in the dashboard
- [ ] Relayer / gasless withdrawals for receivers
- [ ] Mainnet deployment + third-party audit

## Contributing

- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow, testing, and commit/PR conventions.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — community guidelines.
- [docs/architecture.md](docs/architecture.md) — system architecture (C4-style diagrams).
- [docs/architecture-refactor.md](docs/architecture-refactor.md) — modular `/sdk` decoupling blueprint.
- [CHANGELOG.md](CHANGELOG.md) — version history.

## License

[MIT](LICENSE) © StellarStream-Pay contributors.
