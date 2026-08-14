# Contributing to StellarStream-Pay

Thanks for your interest in contributing! StellarStream-Pay is a streaming
payments protocol on Stellar / Soroban, structured as a **frozen core contract**
surrounded by composable extensions. This guide covers the workflow, tooling,
and conventions used across the monorepo.

Please also read the [Code of Conduct](CODE_OF_CONDUCT.md) and
[Security Policy](SECURITY.md).

## Repository layout

```text
contracts/            Cargo workspace
└── core/             frozen stream-core primitive (stream-core v1)
backend/              Express indexer / API (Node 20+, ESM)
frontend/             React + Vite DApp (Freighter wallet)
docs/                 architecture & design docs
.github/workflows/    CI (contract, backend, frontend, PR title lint)
```

## Getting started

```bash
git clone https://github.com/SorobanStream-Network/stellar-stream-pay.git
cd stellar-stream-pay
```

Each workspace has its own toolchain requirements:

| Workspace | Tool | Command |
|-----------|------|---------|
| `contracts/core` | Rust 1.84+ / `stellar-cli` | `cargo test -p stream-core`, `stellar contract build` |
| `backend` | Node 20+ | `npm install`, `npm start` |
| `frontend` | Node 20+ | `npm install`, `npm run build` |

## Development workflow

1. **Fork** the repository and create a feature branch from `main`:

   ```bash
   git checkout -b feat/your-change
   ```

2. **Make focused changes** with clear, self-contained commits. Keep the core
   contract changes minimal — see "Contract changes" below.

3. **Run the checks** for the workspace(s) you touched:

   ```bash
   # contract
   cd contracts/core && cargo test -p stream-core && stellar contract build

   # backend
   cd backend && npm install && node --check src/index.js

   # frontend
   cd frontend && npm install && npm run build
   ```

4. **Open a pull request** with a descriptive title following
   [Conventional Commits](https://www.conventionalcommits.org/) — the PR title is
   linted in CI (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `ci:`, …).

### Contract changes

The `stream-core` contract is **frozen at API v1**. Its public interface
(`create_stream`, `withdraw`, `cancel`, and the read views) must not change;
a breaking change is a migration event (redeploy + reindex) and requires a
`STREAM_CORE_API_VERSION` bump.

New capabilities (splits, schedules, payroll batching, tokenized positions)
belong in **extension contracts** that live alongside `core/` as separate
workspace members and *compose* the core — never in the core itself.

When changing the contract, keep the safety properties intact:

- Every mutating function calls `require_auth()` on the acting party.
- State is written **before** external token calls (check-effects-interactions).
- The settlement invariant holds: `total == withdrawn + refund` after cancel.
- The test suite includes property-based (`proptest`) and invariant tests.

## Commit & PR conventions

- **Commit messages**: imperative mood, present tense, and a Conventional
  Commits type prefix, e.g. `fix(core): reject zero-amount streams`.
- **PR title**: must be semantic (`feat:`, `fix:`, `chore:`, …) — enforced by CI.
- **Scoped commits**: include the workspace when touching more than one, e.g.
  `refactor(backend): use getEvents for indexing`.

## Testing guidelines

- **Contract**: add unit tests for new logic, and extend the `proptest`
  properties or the settlement-invariant scenarios for anything touching the
  vesting math or token movement. Commit the generated `test_snapshots/` files.
- **Backend**: keep the storage-key encoding and event-decoding helpers in sync
  with the contract; the `data_key_encoding_matches_backend_expectations` test
  pins the XDR contract between the two.
- **Frontend**: ensure `npm run build` (tsc + Vite) stays green.

## Reporting issues

- **Bugs / features**: open a GitHub issue with steps to reproduce and, for
  contract issues, a minimal failing test if possible.
- **Security vulnerabilities**: do **not** open a public issue — follow the
  [Security Policy](SECURITY.md) for private, coordinated disclosure.

Thank you for contributing!
