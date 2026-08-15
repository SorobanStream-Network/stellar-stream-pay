# StellarStream-Pay — Modular Architecture Refactoring Blueprint

> **Status:** blueprint / proposal. The TTL-lease, pre-flight/error-decoding,
> and batched-keeper changes shipped in this pass (v4 of `stream-core`, the
> `stellar/` SDK helpers) are written to land in this structure without
> further rework.
>
> **Correction to the request:** the UI shell in this repo is **React + Vite**,
> not Next.js. The blueprint below keeps it that way; every principle (and the
> exact file moves) applies unchanged to a Next.js app — swap `frontend/` for
> `apps/web/` and route handlers for API routes when you get there.

---

## 1. Goal

Today all business logic lives inside `frontend/src/lib/` — it happens to be
framework-agnostic, but it is *located* where it can only ever be consumed by
the React app. The backend re-implements vesting math and storage-key encoding
by hand (`backend/src/index.js`). The contract sits alone in `contracts/core/`.

The target is a dependency-correct monorepo:

```text
┌────────────────────────────────────────────────────────────┐
│ contracts/   on-chain truth (Rust / Soroban)               │
│   └── core/  stream-core v4 — frozen, auditable            │
└──────────────────────────┬─────────────────────────────────┘
                           │ deploys to, indexed from
┌──────────────────────────▼─────────────────────────────────┐
│ sdk/          shared business logic (TypeScript, no React) │
│   └── stellar/  wallet · tx · rpc · errors · preflight     │
│   └── contracts/ stream-core client (invoke + views)       │
│   └── api/      indexer client (typed HTTP)                │
│   └── types/    domain types                               │
└───────┬──────────────────────────────┬─────────────────────┘
        │ imports                      │ imports
┌───────▼──────────┐         ┌──────────▼──────────┐
│ frontend/        │         │ backend/            │
│ React shell only │         │ Express indexer     │
└──────────────────┘         └─────────────────────┘
```

**Dependency rule (enforced):** `contracts` depends on nothing; `sdk` depends
on `@stellar/*` and nothing else in the repo; `frontend` and `backend` depend
on `sdk`. No package imports upward or sideways. The contract's `DataKey`
layout, vesting math, and event shapes live in **one** place (`sdk/`) and are
imported by both apps — never duplicated.

---

## 2. Target file structure

```text
stellar-stream-pay/
├── contracts/                     # Rust / Soroban (unchanged shape)
│   ├── Cargo.toml
│   └── core/
│       ├── src/lib.rs             # stream-core v4 (TTL leases, bump/bump_many/bump_instance)
│       ├── src/test.rs
│       └── Cargo.toml
│
├── sdk/                           # NEW top-level package — the business layer
│   ├── package.json               #   name: "@stellar-stream-pay/sdk"
│   ├── tsconfig.json              #   strict, no DOM by default (Node + browser)
│   ├── src/
│   │   ├── index.ts               #   public barrel — the only allowed import
│   │   ├── types/
│   │   │   └── index.ts           #   ← frontend/src/types/index.ts
│   │   ├── config/
│   │   │   └── index.ts           #   ← frontend/src/config.ts (env injection)
│   │   ├── stellar/
│   │   │   ├── wallet.ts          #   ← frontend/src/lib/stellar/wallet.ts
│   │   │   ├── rpc.ts             #   ← frontend/src/lib/stellar/rpc.ts
│   │   │   ├── tx.ts              #   ← frontend/src/lib/stellar/tx.ts
│   │   │   ├── errors.ts          #   ← frontend/src/lib/stellar/errors.ts
│   │   │   └── preflight.ts       #   ← frontend/src/lib/stellar/preflight.ts
│   │   ├── contracts/
│   │   │   └── stream-core.ts     #   ← frontend/src/lib/contracts/stream-core.ts
│   │   └── api/
│   │       ├── indexer.ts         #   ← frontend/src/lib/api/indexer.ts
│   │       └── server.ts          #   NEW: typed client for backend routes
│   │
│   ├── test/                      #   unit tests (vitest) — errors/preflight/tx
│   └── README.md
│
├── backend/                       # Express indexer (kept)
│   ├── src/
│   │   ├── index.js               #   routes only; math/keys imported from sdk
│   │   ├── app.js                 #   NEW: split server wiring from route defs
│   │   └── keeper.js              #   TTL relayer (permissionless bump / bump_instance)
│   ├── test/                      #   node:test — keeper unit tests
│   └── package.json               #   add workspace dep on @stellar-stream-pay/sdk
│
├── frontend/                      # React shell — views + hooks only
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── components/            #   presentational
│   │   ├── hooks/                 #   TanStack Query + Zustand wiring
│   │   ├── state/                 #   Zustand stores
│   │   └── (lib/ and types/ removed — now `sdk/`)
│   └── package.json               #   add workspace dep on @stellar-stream-pay/sdk
│
├── docs/                          # architecture + this blueprint
├── .github/workflows/             # add sdk CI (tsc + vitest)
└── docker-compose.yml
```

### 2.1 Move map (exact)

| From (today) | To (target) | Notes |
|---|---|---|
| `frontend/src/types/index.ts` | `sdk/src/types/index.ts` | re-export from `sdk/src/index.ts` |
| `frontend/src/config.ts` | `sdk/src/config/index.ts` | env vars injected at construction; no `import.meta` inside sdk |
| `frontend/src/lib/stellar/*` | `sdk/src/stellar/*` | unchanged contents |
| `frontend/src/lib/contracts/stream-core.ts` | `sdk/src/contracts/stream-core.ts` | unchanged contents |
| `frontend/src/lib/api/indexer.ts` | `sdk/src/api/indexer.ts` | |
| `frontend/src/lib/format.ts` | `sdk/src/utils/format.ts` | pure helpers |
| `backend/src/index.js` (vesting math + storage keys) | `sdk/src/indexer/vesting.ts`, `sdk/src/indexer/storage-keys.ts` | **delete the backend duplicates** |
| `backend/src/index.js` (routes) | `backend/src/app.js` + `index.js` | express wiring stays in backend |

### 2.2 Package wiring (npm workspaces)

```jsonc
// root package.json (NEW)
{
  "workspaces": ["sdk", "frontend", "backend"]
}
```

```jsonc
// frontend/package.json — replace relative imports
{
  "dependencies": { "@stellar-stream-pay/sdk": "*" }
}
```

```jsonc
// backend/package.json
{
  "dependencies": { "@stellar-stream-pay/sdk": "*" }
}
```

`sdk/package.json`:

```jsonc
{
  "name": "@stellar-stream-pay/sdk",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" }
}
```

`tsconfig.json` for sdk — **no DOM libs** (runs in Node for the backend; the
browser-only `@stellar/freighter-api` import is isolated in `stellar/wallet.ts`
and `stellar/preflight.ts`, which the backend never imports):

```jsonc
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

Frontend keeps its own `tsconfig`; add `"paths": { "@stellar-stream-pay/sdk":
["../sdk/src/index.ts"] }` during development (source mapping, no build step
needed in dev), and rely on the built package in production builds.

---

## 3. Refactor steps (in order)

1. **Create `sdk/`** and move the files per the move map. Keep imports internal
   to the package (relative), export everything through `sdk/src/index.ts`.
2. **Inject config instead of reading env.** `CONFIG` becomes a factory:
   `createConfig({ rpcUrl, networkPassphrase, contractId, horizonUrl, minGasXlm })`.
   The frontend builds it from `import.meta.env`; the backend builds it from
   `process.env`. Both call the same code with the same shape.
3. **Delete backend duplication.** Replace `vestedAmount`, the `COUNTER_KEY` /
   `streamKey` helpers, and `enrich` in `backend/src/index.js` with imports
   from the sdk. Add one pinned test in `sdk/test/` asserting the storage-key
   XDR matches the contract's pinned snapshot (see
   `data_key_encoding_matches_backend_expectations` in the contract tests).
4. **Re-point imports.** `frontend/src/hooks/*`, `frontend/src/App.tsx`, and
   `frontend/src/state/*` import from `@stellar-stream-pay/sdk` instead of
   `../lib/...`. Delete `frontend/src/lib/` and `frontend/src/types/`.
5. **Wire workspaces** (root `package.json`), update `docker-compose.yml` and
   the Dockerfiles (sdk must be built before frontend/backend images), add a
   `sdk` job to `.github/workflows/`.
6. **Add `backend/src/app.js`** splitting route definitions from `listen()`,
   so the backend can be integration-tested with `supertest` without binding a
   port.

### 3.1 What NOT to do

- **Do not** move `hooks/`, `state/`, or `components/` into sdk — they are
  React concerns and stay in the shell.
- **Do not** let sdk import `@stellar/freighter-api` at module top level for
  backend use — keep Freighter imports confined to `stellar/wallet.ts` /
  `stellar/preflight.ts` and import those lazily (dynamic import) from
  browser-only entrypoints.
- **Do not** add a second vesting-math implementation anywhere. The contract
  is the source of truth; sdk mirrors it once; the backend imports sdk.
- **Do not** make this a breaking refactor — it is a *move* + *re-point* pass.
  No behavior changes; run `tsc -b`, `vitest`, and the backend smoke test after
  every step.

---

## 4. How this pass fits the blueprint

The code landed in this change is already structured for the move:

- `frontend/src/lib/stellar/errors.ts` — pure, framework-agnostic (moves as-is).
- `frontend/src/lib/stellar/preflight.ts` — pure aside from the `CONFIG` import;
  step 2 (config factory) removes the only coupling.
- `frontend/src/lib/contracts/stream-core.ts` — imports only `stellar/*` and
  `types` (moves as-is).
- `frontend/src/types/index.ts` — no React imports (moves as-is).

The only files that need touch-ups during the move are `config.ts` (step 2) and
any hook that currently imports `../../lib/...` (step 4).

---

## 5. Contract ↔ SDK contract of record

Keep this table in `sdk/README.md` and update it on every contract change:

| Contract `DataKey` | SDK key builder | XDR pinned by |
|---|---|---|
| `Counter` | `storageKeys.counter()` | contract test + sdk test |
| `Stream(u64)` | `storageKeys.stream(id)` | contract test + sdk test |
| `Admin` / `Paused` / `Split(u64)` | `storageKeys.*` | contract test + sdk test |

| Error code | SDK message key |
|---|---|
| 1–20 (see `STREAM_CORE_ERRORS`) | `errors.ts` map |

| Entrypoint | SDK client fn |
|---|---|
| `create_stream` / `withdraw` / `cancel` | `stream-core.ts` (pre-flighted) |
| `bump` / `bump_many` / `bump_instance` | `stream-core.ts` keepers |
| views (`get_stream`, `get_split`, …) | `stream-core.ts` view helpers (add) |

---

## 6. Migration checklist

- [ ] `sdk/` exists; `tsc -p sdk` clean; `vitest` green
- [ ] frontend builds with zero `../lib` imports
- [ ] backend imports vesting + keys from sdk; `/api/stream/:address` byte-identical responses
- [ ] `docker compose build` succeeds (sdk built first)
- [ ] CI runs sdk typecheck + tests
