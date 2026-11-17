import assert from "node:assert/strict";
import test from "node:test";
import { createPair, waitFor } from "./harness.js";

test("linked pair becomes ready over MQTT and completes a ping", async () => {
  const config = { bytes: 24, intervalMs: 60_000, concurrency: 1 };
  const mesh = await createPair(config);
  try {
    await waitFor(() => mesh.pairs.every((pair) => pair.isReady));
    assert.equal(mesh.pairs[0].snapshot().route, "mqtt");
    assert.equal(mesh.pairs[1].snapshot().route, "mqtt");
    await mesh.pairs[0].sendPing();
    await waitFor(() => mesh.pairs[0].snapshot().roundTrips === 1);
    const a = mesh.pairs[0];
    assert.equal(a.snapshot().pings, 1);
    assert.equal(a.traffic().tx.mqtt.bytes, config.bytes);
    assert.equal(a.traffic().rx.mqtt.bytes, config.bytes);
    assert.equal(a.snapshot().lastError, null);
    assert.equal(mesh.pairs[1].snapshot().lastError, null);
  } finally {
    mesh.dispose();
  }
});

test("duplicate client hello race does not reset the responder session", async () => {
  const mesh = await createPair();
  try {
    // A retry can deliver identical bytes concurrently before manager installation;
    // losing this race can create/reset session state and break subsequent traffic.
    let duplicate: Promise<void> | undefined;
    const source = mesh.connections[0]!;
    const original = source.publish.bind(source);
    source.publish = async (topic, payload) => {
      if (topic.includes("signal") && !duplicate) {
        const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
        const message = JSON.parse(text);
        if (message.hello?.kind === "client-hello") {
          duplicate = Promise.all([
            mesh.pairs[1].handleHandshake(JSON.parse(text)),
            mesh.pairs[1].handleHandshake(JSON.parse(text)),
          ]).then(() => undefined);
        }
      }
      await original(topic, payload);
    };
    mesh.pairs[0].start();
    await waitFor(() => duplicate !== undefined);
    await duplicate;
    await waitFor(() => mesh.pairs.every((pair) => pair.isReady));
    const responder = mesh.pairs[1].snapshot();
    assert.equal(responder.lastError, null);
    assert.equal(responder.route, "mqtt");
    await mesh.pairs[0].sendPing();
    await waitFor(() => mesh.pairs[0].snapshot().roundTrips === 1);
    assert.equal(mesh.pairs[1].snapshot().lastError, null);
  } finally {
    mesh.dispose();
  }
});
