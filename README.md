# StellarStream-Pay

Multi-tier cross-border payroll and continuous streaming payment infrastructure
built on [Stellar](https://stellar.org) / [Soroban](https://developers.stellar.org/docs/smart-contracts).

A **stream** is a linearly-vesting payment: a sender locks a token amount for a
fixed duration, and the receiver can withdraw the pro-rata amount that has
accrued so far — on demand, at any time. Streams can be denominated in any
SEP-41 token, including Stellar Asset Contract (SAC) wrapped native assets
(XLM, USDC, EURC, …).

```
accrued(t) = total × min(t, end) − start
                    ─────────────────────
                         end − start
```

---

## Repository layout

```
stellar-stream-pay/
├── contracts/          # Rust / Soroban smart contract
│   ├── src/lib.rs      #   create_stream, withdraw, cancel_stream + views
│   └── Cargo.toml
├── backend/            # Node.js / Express indexer & API
│   └── src/index.js    #   reads stream state from Soroban RPC + Horizon
├── frontend/           # React / Vite DApp with Freighter wallet
│   └── src/App.tsx     #   dashboard: view/manage streams, trigger withdrawals
└── README.md
```

### How the pieces fit together

- **Contract** — holds locked funds and enforces the linear vesting schedule.
  Emits `created`, `withdrawn`, and `cancelled` events for indexers.
- **Backend** — Express API that reads contract storage directly via Soroban
  RPC (`getContractData`) and classic balances via Horizon. Serves the
  frontend with decorated stream data (accrued / withdrawable / progress).
- **Frontend** — Freighter wallet integration; builds, simulates, assembles,
  signs, and submits `withdraw` / `create_stream` transactions with
  `@stellar/stellar-sdk`.

---

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

---

## 1. Build & deploy the contract

```bash
cd contracts
stellar contract build
```

This compiles `src/lib.rs` to
`target/wasm32v1-none/release/stellar_stream_pay.wasm`.
(Always use `stellar contract build` — never `cargo build`.)

Upload (install) the Wasm, then deploy an instance:

```bash
# Install the compiled Wasm; prints a hex wasm hash.
stellar contract upload \
  --wasm target/wasm32v1-none/release/stellar_stream_pay.wasm \
  --network testnet

# Deploy an instance from that hash; prints the contract id (C...).
stellar contract deploy \
  --wasm-hash <WASM_HASH> \
  --network testnet
```

Copy the contract id — you'll need it for the backend and frontend.

> **Run the unit tests** for the vesting math with:
> ```bash
> cd contracts && cargo test
> ```

---

## 2. Run the backend

```bash
cd backend
cp .env.example .env        # then set STREAM_CONTRACT_ID to your contract id
npm install
npm start                   # or: npm run dev (watch mode)
```

The server listens on `http://localhost:4000` and exposes:

| Endpoint | Description |
|----------|-------------|
| `GET /health` | RPC connectivity + network info |
| `GET /api/stream/:address` | Streams where `:address` is sender or receiver (Soroban RPC) |
| `GET /api/account/:address` | Classic/SAC balances for an address (Horizon) |

Example:

```bash
curl http://localhost:4000/api/stream/GBVZ...YOUR...ADDRESS
```

---

## 3. Run the frontend

```bash
cd frontend
cp .env.example .env       # set VITE_CONTRACT_ID to your contract id
npm install
npm run dev                # http://localhost:5173
```

Make sure the backend is running (the dashboard reads streams from
`VITE_BACKEND_URL`). Then:

1. Click **Connect Freighter**.
2. **Create a stream** by entering a receiver, the SAC/token contract id, the
   amount in base units, and a duration in seconds.
3. Any stream where you are the receiver shows a **Withdraw** button once
   something has vested.

---

## Contract API

| Function | Auth | Description |
|----------|------|-------------|
| `create_stream(sender, receiver, token, amount, duration_seconds) -> u64` | `sender` | Locks `amount` (base units) from `sender` and starts a stream. |
| `withdraw(receiver, stream_id) -> i128` | `receiver` | Pays out the currently accrued (un-withdrawn) amount. |
| `cancel_stream(sender, stream_id) -> i128` | `sender` | Cancels and refunds the unvested remainder to `sender`. |
| `get_stream(stream_id) -> Stream` | — | Read a stream. |
| `get_accrued(stream_id) -> i128` | — | Current vested amount. |
| `get_withdrawable(stream_id) -> i128` | — | Amount currently available to withdraw. |
| `get_stream_count() -> u64` | — | Total streams ever created. |

### Storage layout (for indexers)

- Streams: **persistent** storage, keyed by `u64` stream id.
- Stream counter: **persistent** storage, keyed by `Symbol("count")`.

The backend reads both directly via RPC `getContractData`.

---

## Security notes

- **Authorization** — `create_stream`, `withdraw`, and `cancel_stream` each
  call `require_auth()` on the acting party; token pulls/pushes flow through
  the SEP-41 `token::Client`, which enforces its own auth.
- **Check-effects-interactions** — stream state is updated *before* external
  token calls, and arithmetic overflow traps (rather than wraps) thanks to
  `overflow-checks = true` in the release profile.
- **SAC compatibility** — transfers use the standard SEP-41 `token::Client`,
  which works for SAC-wrapped native assets and custom tokens alike.
  `token::StellarAssetClient` (mint/clawback/admin) is intentionally unused.
- **Frontend signing** — transactions are simulated + assembled via
  `prepareTransaction` (so auth entries/footprints are correct) before Freighter
  signs; the app never touches private keys.
- **Indexer scaling** — the backend scans stream ids `0..count` for simplicity.
  For large fleets, index the contract's `created` / `withdrawn` / `cancelled`
  events instead (see `StreamEvent`).

---

## Networks

Defaults target **Testnet**. For Mainnet, switch `RPC_URL`, `HORIZON_URL`,
`VITE_RPC_URL`, and `VITE_NETWORK_PASSPHRASE`
(`Public Global Stellar Network ; September 2015`) and deploy with
`--network mainnet`.

## License

Apache-2.0 (see `LICENSE`).
