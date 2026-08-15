/**
 * TTL keeper unit tests (node:test — no extra dependencies).
 *
 * `createKeeper` accepts an injected `rpc`, so these tests drive the full
 * pass logic (counter read → TTL scan → bump planning → batched submission
 * → fallback) against a fake RPC that records every transaction it is asked
 * to prepare. The fake inspects the *real* SDK-built transaction, so the
 * assertions also prove the keeper builds `bump_instance()` / `bump_many(ids)`
 * / `bump(id)` invocations with the correct method names and ScVal arguments.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Account, Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { createKeeper } from "../src/keeper.js";

// A syntactically valid contract id (from the SDK docs) — createKeeper only
// needs it to construct a `Contract`; the fake RPC never touches the network.
const CONTRACT_ID = "CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const SECRET = Keypair.random().secret();
const scvU64 = (n) => nativeToScVal(n, { type: "u64" }).toXDR("base64");
const scvVec = (ids) =>
  nativeToScVal(ids, { type: ids.map(() => "u64") }).toXDR("base64");

/**
 * Extract the invoked method + args from a built (unsigned) transaction.
 * In stellar-sdk v16, `tx.operations[0]` is `{ type, func, auth }` where
 * `func` is the HostFunction union directly.
 */
function extractCall(tx) {
  const invoke = tx.operations[0].func.invokeContract();
  return {
    method: invoke.functionName().toString(),
    args: invoke.args().map((arg) => arg.toXDR("base64")),
  };
}

/**
 * Fake Soroban RPC. `ttlById[i]` is the remaining TTL (ledgers) the fake
 * reports for stream id `i`; a stream with no entry is treated as
 * archived/missing. `failWhen(call)` makes `sendTransaction` return ERROR,
 * simulating an on-chain rejection for matching calls.
 */
function makeFakeRpc({ count = 0, ttlById = {}, failWhen = () => false, latestLedger = 1_000_000 }) {
  const calls = [];
  const rpc = {
    async getContractData() {
      // Mirrors what src/index.js reads: LedgerEntryData -> ContractData -> ScVal.
      // `nativeToScVal` wraps the u64 properly (raw `scvU64(number)` stores a
      // bare Number, which `scValToNative` rejects).
      return { val: { value: () => ({ val: () => nativeToScVal(count, { type: "u64" }) }) } };
    },
    async getLedgerEntries(...keys) {
      const entries = [];
      keys.forEach((key, i) => {
        if (ttlById[i] === undefined) return; // absent/archived -> skipped
        entries.push({ key, liveUntilLedgerSeq: latestLedger + ttlById[i] });
      });
      return { latestLedger, entries };
    },
    async getAccount(pub) {
      return new Account(pub, "100");
    },
    async prepareTransaction(tx) {
      calls.push(extractCall(tx));
      return tx;
    },
    async sendTransaction() {
      const call = calls[calls.length - 1];
      if (failWhen(call)) {
        return { status: "ERROR", hash: "0".repeat(64) };
      }
      return { status: "PENDING", hash: "a".repeat(64) };
    },
    async getTransaction() {
      return { status: "SUCCESS" };
    },
  };
  return { rpc, calls };
}

function makeKeeper(options = {}) {
  const { rpc, calls } = makeFakeRpc(options);
  const keeper = createKeeper({
    rpc,
    contractId: CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    secret: SECRET,
    thresholdLedgers: 1000,
    ...options.keeperOpts,
  });
  return { keeper, calls };
}

// ---------------------------------------------------------------------------

test("re-arms the instance and batches due streams into one bump_many call", async () => {
  // 3 streams: ids 0 and 2 are below the 1000-ledger threshold, id 1 is healthy.
  const { keeper, calls } = makeKeeper({ count: 3, ttlById: { 0: 100, 1: 500_000, 2: 50 } });
  const { summary, failed, metrics } = await keeper.runPass();

  assert.deepEqual(failed, []);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["bump_instance", "bump_many"],
  );
  // bump_instance takes no args; bump_many carries the due ids as a u64 vec.
  assert.deepEqual(calls[0].args, []);
  assert.deepEqual(calls[1].args, [scvVec([0, 2])]);
  assert.match(summary, /threshold 1000 ledgers/);
  // Pass metrics drive the status monitor.
  assert.deepEqual(metrics, {
    streams: 3,
    due: 2,
    covered: 2,
    batches: 1,
    instanceBumped: true,
    dryRun: false,
  });
});

test("chunks large due sets into multiple bump_many batches", async () => {
  const { keeper, calls } = makeKeeper({
    count: 5,
    ttlById: { 0: 10, 1: 20, 2: 30, 3: 40, 4: 50 },
    keeperOpts: { bumpBatchSize: 2 },
  });
  const { summary, failed, metrics } = await keeper.runPass();

  assert.deepEqual(failed, []);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["bump_instance", "bump_many", "bump_many", "bump_many"],
  );
  assert.deepEqual(
    calls.slice(1).map((c) => c.args[0]),
    [scvVec([0, 1]), scvVec([2, 3]), scvVec([4])],
  );
  assert.equal(metrics.covered, 5);
});

test("dry run plans every action but submits nothing", async () => {
  const { keeper, calls } = makeKeeper({
    count: 2,
    ttlById: { 0: 10, 1: 20 },
    keeperOpts: { dryRun: true },
  });
  const { summary, failed, metrics } = await keeper.runPass();

  assert.deepEqual(calls, []);
  assert.deepEqual(failed, []);
  assert.match(summary, /DRY RUN/);
  assert.match(summary, /would send/);
  assert.equal(metrics.dryRun, true);
  assert.equal(metrics.covered, 0);
});

test("with no streams only the instance is bumped", async () => {
  const { keeper, calls } = makeKeeper({ count: 0, ttlById: {} });
  const { summary, failed, metrics } = await keeper.runPass();

  assert.deepEqual(failed, []);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["bump_instance"],
  );
  assert.match(summary, /nothing to bump/);
  assert.equal(metrics.streams, 0);
  assert.equal(metrics.due, 0);
  assert.equal(metrics.covered, 0);
  assert.equal(metrics.instanceBumped, true);
});

test("recovers cleanly when the deployed contract predates bump_many", async () => {
  // Any bump_many rejection (old contract, oversized footprint, network) falls
  // back to per-stream bump calls so nothing is left un-re-armed.
  const { keeper, calls } = makeKeeper({
    count: 3,
    ttlById: { 0: 10, 1: 20, 2: 30 },
    failWhen: (call) => call.method === "bump_many",
  });
  const { summary, failed, metrics } = await keeper.runPass();

  assert.deepEqual(failed, []);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["bump_instance", "bump_many", "bump", "bump", "bump"],
  );
  assert.deepEqual(
    calls.slice(2).map((c) => c.args[0]),
    [scvU64(0), scvU64(1), scvU64(2)],
  );
  assert.match(summary, /falling back to individual bumps/);
  assert.equal(metrics.covered, 3); // every stream recovered via fallback
});

test("falls back to individual bumps and isolates failures within the fallback", async () => {
  const { keeper, calls } = makeKeeper({
    count: 2,
    ttlById: { 0: 10, 1: 20 },
    failWhen: (call) =>
      call.method === "bump_many" || (call.method === "bump" && call.args[0] === scvU64(0)),
  });
  const { summary, failed, metrics } = await keeper.runPass();

  // Batch attempt recorded, then the per-id fallback runs both.
  assert.deepEqual(
    calls.map((c) => c.method),
    ["bump_instance", "bump_many", "bump", "bump"],
  );
  assert.equal(failed.length, 1);
  assert.match(failed[0], /bump\(0\)/);
  assert.match(summary, /falling back to individual bumps/);
  assert.match(summary, /bump\(1\)/);
  assert.equal(metrics.covered, 1); // only the healthy fallback bump succeeded
  assert.equal(metrics.instanceBumped, true);
});

test("archived or missing stream entries are skipped, not bumped", async () => {
  // Stream id 0 has no ledger entry (absent/archived); only id 1 is live.
  const { keeper, calls } = makeKeeper({ count: 2, ttlById: { 1: 10 } });
  const { summary, failed } = await keeper.runPass();

  assert.deepEqual(failed, []);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["bump_instance", "bump_many"],
  );
  assert.deepEqual(calls[1].args, [scvVec([1])]);
  assert.match(summary, /stream 0: entry missing\/archived — skip/);
});

test("an unreadable counter surfaces a configuration error", async () => {
  const { rpc, calls } = makeFakeRpc({ count: 3, ttlById: {} });
  rpc.getContractData = async () => {
    throw new Error("contract data not found");
  };
  const keeper = createKeeper({
    rpc,
    contractId: CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    secret: SECRET,
  });
  await assert.rejects(keeper.runPass(), /is STREAM_CONTRACT_ID correct\?/);
});

test("refuses to start without a contract id, a secret, or a valid secret", () => {
  const base = { rpc: {}, networkPassphrase: NETWORK_PASSPHRASE, secret: SECRET };
  assert.throws(() => createKeeper({ ...base, contractId: "" }), /STREAM_CONTRACT_ID/);
  assert.throws(
    () => createKeeper({ ...base, contractId: CONTRACT_ID, secret: "" }),
    /KEEPER_SECRET/,
  );
  assert.throws(
    () => createKeeper({ ...base, contractId: CONTRACT_ID, secret: "not-a-secret" }),
    /not a valid Stellar secret/,
  );
});
