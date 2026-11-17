import assert from "node:assert/strict";
import test from "node:test";
import { selectPingPeers } from "../ping-scheduler.js";

test("scheduler respects per-peer spacing and pair concurrency eligibility", () => {
  const config = { bytes: 8, intervalMs: 10, concurrency: 3 };
  const peers = [1, 2, 3, 4].map((n) => ({
    peerId: `p${n}`,
    lastPingAt: 90,
    canPing: n !== 2,
  }));
  assert.deepEqual(selectPingPeers(99, config, peers), []);
  assert.deepEqual(selectPingPeers(100, config, peers), ["p1", "p3", "p4"]);
  assert.deepEqual(selectPingPeers(100, { ...config, concurrency: 1 }, peers), ["p1", "p3", "p4"]);
  assert.deepEqual(selectPingPeers(100, config, peers, 2), ["p3", "p4", "p1"]);
});

test("scheduler selects all spaced eligible peers regardless of per-pair concurrency", () => {
  const peers = ["a", "b", "c"].map((peerId) => ({ peerId, lastPingAt: 0, canPing: true }));
  assert.deepEqual(selectPingPeers(10, { bytes: 1, intervalMs: 10, concurrency: 1 }, peers), [
    "a",
    "b",
    "c",
  ]);
});
