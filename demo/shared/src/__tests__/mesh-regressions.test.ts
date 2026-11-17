import assert from "node:assert/strict";
import test from "node:test";
import { createMeshPeer } from "../mesh.js";
import type { MeshPingConfig } from "../types.js";
import { createPair, waitFor } from "./harness.js";

function createUnstartedPeer() {
  return createMeshPeer({
    url: "mqtt://unused",
    name: "test",
    kind: "nest",
    peerId: "test",
    pingBytes: 16,
    pingIntervalMs: 100,
    pingConcurrency: 1,
    engine: {} as never,
  });
}

test("setPingConfig accepts the inclusive limits", () => {
  const peer = createUnstartedPeer();
  assert.deepEqual(peer.setPingConfig({ bytes: 1, intervalMs: 10, concurrency: 1 }), {
    bytes: 1,
    intervalMs: 10,
    concurrency: 1,
  });
  assert.deepEqual(peer.setPingConfig({ bytes: 60_000, intervalMs: 60_000, concurrency: 32 }), {
    bytes: 60_000,
    intervalMs: 60_000,
    concurrency: 32,
  });
});

test("setPingConfig rejects invalid values atomically", () => {
  const peer = createUnstartedPeer();
  for (const invalid of [
    { bytes: 1.5 },
    { bytes: 0 },
    { bytes: 60_001 },
    { intervalMs: 9 },
    { intervalMs: 60_001 },
    { concurrency: 0 },
    { concurrency: 33 },
    { bytes: 10, concurrency: 1.5 },
  ]) {
    const before = peer.getPingConfig();
    assert.throws(
      () => peer.setPingConfig(invalid),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "INVALID_CONFIG");
        return true;
      },
    );
    assert.deepEqual(peer.getPingConfig(), before);
  }
});

test("getPingConfig returns an independent copy", () => {
  const peer = createUnstartedPeer();
  const config = peer.getPingConfig();
  config.bytes = 999;
  assert.equal(peer.getPingConfig().bytes, 16);
});

test("setPingConfig applies immediately to the snapshot", () => {
  const peer = createUnstartedPeer();
  const expected = { bytes: 512, concurrency: 4, intervalMs: 250 };
  assert.deepEqual(peer.setPingConfig(expected), expected);
  assert.deepEqual(peer.getPingConfig(), expected);
  assert.deepEqual(peer.getSnapshot().ping, expected);
});

test("existing pair sends updated ping payload sizes", async () => {
  const config: MeshPingConfig = { bytes: 16, intervalMs: 60_000, concurrency: 1 };
  const mesh = await createPair(config);
  try {
    await waitFor(() => mesh.pairs.every((pair) => pair.isReady));
    config.bytes = 257;
    await mesh.pairs[0].sendPing();
    await waitFor(() => mesh.pairs[0].snapshot().roundTrips === 1);
    assert.equal(mesh.pairs[0].snapshot().traffic.tx.mqtt.bytes, 257);
    assert.equal(mesh.pairs[0].snapshot().traffic.rx.mqtt.bytes, 257);
  } finally {
    mesh.dispose();
  }
});

// Covers retry/recovery with hasCandidates reporting true; it does not exercise an actual P2P route.
test("failed MQTT confirmation recovers despite another P2P candidate", async () => {
  const mesh = await createPair(undefined, { state: "connecting", transportConfirmTimeoutMs: 80 });
  try {
    const context = (
      mesh.pairs[0] as unknown as { ctx: { router: { hasCandidates: (peer: string) => boolean } } }
    ).ctx;
    context.router.hasCandidates = () => true;
    const connection = mesh.connections[0]!;
    const original = connection.publish.bind(connection);
    let clientHellos = 0;
    connection.publish = async (topic, payload) => {
      if (topic.includes("signal")) {
        const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
        if (JSON.parse(text).hello?.kind === "client-hello") clientHellos += 1;
      }
      await original(topic, payload);
    };
    await waitFor(() => clientHellos > 0);
    await waitFor(() => mesh.pairs[0].snapshot().lastError !== null);
    assert.equal(mesh.pairs[0].isReady, false);
    assert.equal(mesh.pairs[0].snapshot().route, "connecting");
    await waitFor(() => clientHellos > 1, 3_000);
    assert.equal(context.router.hasCandidates("mesh-b"), true);
    for (const connection of mesh.connections) connection.setState("open");
    await waitFor(() => mesh.pairs.every((pair) => pair.isReady));
    assert.equal(mesh.pairs[0].snapshot().route, "mqtt");
  } finally {
    mesh.dispose();
  }
});

test("responder does not become ready before initial transport confirmation", async () => {
  const mesh = await createPair(undefined, { state: "connecting", transportConfirmTimeoutMs: 80 });
  try {
    await waitFor(() => mesh.pairs[1].snapshot().route === "connecting");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(mesh.pairs[1].isReady, false);
    for (const connection of mesh.connections) connection.setState("open");
    await waitFor(() => mesh.pairs.every((pair) => pair.isReady));
    assert.equal(mesh.pairs[1].snapshot().lastError, null);
    await mesh.pairs[0].sendPing();
    await waitFor(() => mesh.pairs[0].snapshot().roundTrips === 1);
    assert.equal(mesh.pairs[0].snapshot().roundTrips, 1);
  } finally {
    mesh.dispose();
  }
});
