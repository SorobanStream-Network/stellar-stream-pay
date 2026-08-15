/**
 * Pass-status monitor tests (node:test).
 *
 * `createMonitor` records the outcome of each keeper pass and exposes it
 * over a small HTTP endpoint — `/health` (liveness), `/status` (last pass
 * result + errors), and `/metrics` (Prometheus text-format counters and
 * last-pass gauges for Grafana alerting) — so operators and container probes
 * can verify that re-arming is actually happening.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createMonitor } from "../src/keeper.js";

test("records pass outcomes and errors", () => {
  const monitor = createMonitor({ nextPassInSec: 60 });

  const before = monitor.status();
  assert.equal(before.status, "ok");
  assert.equal(before.lastPass, null);
  assert.equal(before.lastError, null);
  assert.equal(before.nextPassInSec, 60);

  monitor.record({
    ok: true,
    streams: 3,
    due: 2,
    covered: 2,
    instanceBumped: true,
    dryRun: false,
    failed: [],
    durationMs: 42,
  });
  const after = monitor.status();
  assert.equal(after.status, "ok");
  assert.ok(after.lastPass.ts, "last pass carries a timestamp");
  assert.equal(after.lastPass.covered, 2);
  assert.equal(after.lastPass.instanceBumped, true);
  assert.equal(after.lastError, null);

  // An outright pass failure (bad config, unreachable RPC) marks degraded but
  // keeps the last successful pass visible for diagnosis.
  monitor.recordError("RPC unreachable");
  const degraded = monitor.status();
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.lastError, "RPC unreachable");
  assert.equal(degraded.lastPass.covered, 2);
});

test("health and status endpoints expose the pass state over HTTP", async () => {
  const monitor = createMonitor({ nextPassInSec: 60 });
  const server = monitor.startHttp({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Liveness: process is up.
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.status, "ok");
    assert.ok(healthJson.startedAt);
    assert.ok(healthJson.uptimeSec >= 0);

    // Before any pass: no last pass, still healthy.
    const fresh = await (await fetch(`${base}/status`)).json();
    assert.equal(fresh.status, "ok");
    assert.equal(fresh.lastPass, null);
    assert.equal(fresh.nextPassInSec, 60);

    // After a recorded pass.
    monitor.record({
      ok: true,
      streams: 3,
      due: 2,
      covered: 2,
      instanceBumped: true,
      dryRun: false,
      failed: [],
      durationMs: 42,
    });
    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.status, "ok");
    assert.equal(status.lastPass.ok, true);
    assert.equal(status.lastPass.covered, 2);
    assert.equal(status.lastPass.durationMs, 42);

    // After an error: degraded, error surfaced, last pass still visible.
    monitor.recordError("RPC unreachable");
    const degraded = await (await fetch(`${base}/status`)).json();
    assert.equal(degraded.status, "degraded");
    assert.equal(degraded.lastError, "RPC unreachable");
    assert.equal(degraded.lastPass.covered, 2);

    // Unknown paths are 404.
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
  }
});

test("health server listen errors are non-fatal", async () => {
  const monitor = createMonitor();
  // Grab the port of a first server, then try to bind a second one to it.
  const first = monitor.startHttp({ host: "127.0.0.1", port: 0 });
  await once(first, "listening");
  const takenPort = first.address().port;
  try {
    const second = monitor.startHttp({ host: "127.0.0.1", port: takenPort });
    // Listen errors are logged (console.warn), not thrown — the keeper keeps
    // running even if monitoring can't bind.
    await once(second, "error");
  } finally {
    first.close();
  }
});

test("prometheus metrics accumulate counters and expose last-pass gauges", () => {
  const monitor = createMonitor();

  // A fresh process still emits every series (zeroed) so scrapes work from
  // the first pass and alerting rules never wait for a series to appear.
  const fresh = monitor.metrics();
  assert.match(fresh, /^# HELP stream_core_keeper_up /m);
  assert.match(fresh, /^# TYPE stream_core_keeper_passes_total counter$/m);
  assert.match(fresh, /^# TYPE stream_core_keeper_last_pass_ok gauge$/m);
  assert.match(fresh, /^stream_core_keeper_bumps_total 0$/m);
  assert.match(fresh, /^stream_core_keeper_last_pass_ok 0$/m);
  assert.match(fresh, /^stream_core_keeper_last_pass_timestamp_seconds 0$/m);

  monitor.record({
    ok: true,
    streams: 5,
    due: 3,
    covered: 3,
    batches: 1,
    instanceBumped: true,
    dryRun: false,
    failed: [],
    durationMs: 120,
  });
  let m = monitor.metrics();
  assert.match(m, /^stream_core_keeper_up 1$/m);
  assert.match(m, /^stream_core_keeper_passes_total 1$/m);
  assert.match(m, /^stream_core_keeper_pass_failures_total 0$/m);
  assert.match(m, /^stream_core_keeper_bumps_total 3$/m);
  assert.match(m, /^stream_core_keeper_batches_total 1$/m);
  assert.match(m, /^stream_core_keeper_failures_total 0$/m);
  assert.match(m, /^stream_core_keeper_last_pass_ok 1$/m);
  assert.match(m, /^stream_core_keeper_last_pass_duration_seconds 0.12$/m);
  assert.match(m, /^stream_core_keeper_streams 5$/m);
  assert.match(m, /^stream_core_keeper_due_streams 3$/m);
  assert.match(m, /^stream_core_keeper_covered_streams 3$/m);
  assert.match(m, /^stream_core_keeper_instance_bumped 1$/m);
  assert.match(m, /^stream_core_keeper_last_pass_timestamp_seconds [0-9]+(\.[0-9]+)?$/m);

  // A pass with a failed item: counters accumulate, the ok gauge flips.
  monitor.record({
    ok: false,
    streams: 5,
    due: 1,
    covered: 0,
    batches: 0,
    instanceBumped: true,
    dryRun: false,
    failed: ["bump(2): rejected by the network: TX_FAILED"],
    durationMs: 80,
  });
  m = monitor.metrics();
  assert.match(m, /^stream_core_keeper_passes_total 2$/m);
  assert.match(m, /^stream_core_keeper_pass_failures_total 1$/m);
  assert.match(m, /^stream_core_keeper_failures_total 1$/m);
  assert.match(m, /^stream_core_keeper_last_pass_ok 0$/m);
  assert.match(m, /^stream_core_keeper_bumps_total 3$/m); // nothing covered this pass

  // Dry-run passes send nothing and must not inflate the work counters.
  monitor.record({
    ok: true,
    streams: 5,
    due: 5,
    covered: 0,
    batches: 0,
    instanceBumped: false,
    dryRun: true,
    failed: [],
    durationMs: 10,
  });
  m = monitor.metrics();
  assert.match(m, /^stream_core_keeper_passes_total 3$/m);
  assert.match(m, /^stream_core_keeper_bumps_total 3$/m);
  assert.match(m, /^stream_core_keeper_failures_total 1$/m);

  // An outright pass failure (bad config, unreachable RPC) counts as a pass
  // + failure, keeps the last successful pass visible, and flips the gauge.
  monitor.recordError("RPC unreachable");
  m = monitor.metrics();
  assert.match(m, /^stream_core_keeper_passes_total 4$/m);
  assert.match(m, /^stream_core_keeper_pass_failures_total 2$/m);
  assert.match(m, /^stream_core_keeper_failures_total 2$/m);
  assert.match(m, /^stream_core_keeper_last_pass_ok 0$/m);
});

test("metrics endpoint serves Prometheus text format over HTTP", async () => {
  const monitor = createMonitor();
  const server = monitor.startHttp({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/plain/);
    const body = await res.text();
    assert.match(body, /^# HELP stream_core_keeper_up /m);
    assert.match(body, /^stream_core_keeper_up 1$/m);
    assert.match(body, /^stream_core_keeper_passes_total 0$/m);

    // After a pass, counters + gauges reflect it.
    monitor.record({
      ok: true,
      streams: 2,
      due: 2,
      covered: 2,
      batches: 1,
      instanceBumped: true,
      dryRun: false,
      failed: [],
      durationMs: 50,
    });
    const body2 = await (await fetch(`${base}/metrics`)).text();
    assert.match(body2, /^stream_core_keeper_bumps_total 2$/m);
    assert.match(body2, /^stream_core_keeper_batches_total 1$/m);
    assert.match(body2, /^stream_core_keeper_last_pass_ok 1$/m);
    assert.match(body2, /^stream_core_keeper_due_streams 2$/m);
  } finally {
    server.close();
  }
});
