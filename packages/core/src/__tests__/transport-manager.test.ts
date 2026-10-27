import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSecurity, Transport } from "../transport.js";
import { TransportManager } from "../transport-manager.js";
import type { TransportKind, TransportState, Unsubscribe } from "../types.js";
import { createEnvelope, encodeEnvelopeJson, type Envelope } from "../protocol.js";

const sid = "abcdefghijklmnop";

class FakeTransport implements Transport {
  readonly kind: TransportKind;
  state: TransportState = "connecting";
  sent: Uint8Array[] = [];
  private dataListeners = new Set<(data: Uint8Array) => void>();
  private stateListeners = new Set<(state: TransportState) => void>();

  constructor(kind: TransportKind) {
    this.kind = kind;
  }

  async send(data: Uint8Array): Promise<void> {
    if (this.state !== "open") throw new Error("not open");
    this.sent.push(data);
  }

  onData(listener: (data: Uint8Array) => void): Unsubscribe {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onStateChange(listener: (state: TransportState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.state = "closed";
    for (const listener of this.stateListeners) listener(this.state);
  }

  setState(state: TransportState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  inject(data: Uint8Array): void {
    for (const listener of this.dataListeners) listener(data);
  }

  envelopes(): Envelope[] {
    return this.sent.map((data) => JSON.parse(new TextDecoder().decode(data)) as Envelope);
  }
}

const identitySecurity: SessionSecurity = {
  sessionId: sid,
  seal: async (_transport, plaintext) => plaintext,
  open: async (_transport, frame) => frame,
  destroy: () => undefined,
};

describe("TransportManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  function pongFor(transport: FakeTransport, ping: Envelope): Uint8Array {
    const pong = createEnvelope("pong", sid, null, { cid: ping.id });
    return encodeEnvelopeJson(pong, 65536);
  }

  it("starts on MQTT, promotes stable WebRTC and falls back", async () => {
    const mqtt = new FakeTransport("mqtt");
    const webrtc = new FakeTransport("webrtc");
    const changes: Array<[TransportKind | null, TransportKind | null]> = [];
    const manager = new TransportManager({
      sessionId: sid,
      clientId: "client-1",
      serverId: "server-1",
      transports: { mqtt, webrtc },
      security: identitySecurity,
      limits: { promoteAfterMs: 3000, heartbeatIntervalMs: 5000, heartbeatTimeoutMs: 15000 },
      onTransportChange: (from, to) => changes.push([from, to]),
    });
    manager.start();

    mqtt.setState("open");
    await flush();
    const ping = mqtt.envelopes().find((envelope) => envelope.type === "ping");
    expect(ping).toBeTruthy();
    mqtt.inject(pongFor(mqtt, ping!));
    await flush();
    expect(manager.getSnapshot().status).toBe("mqtt");

    webrtc.setState("open");
    await flush();
    const p2pPing = webrtc.envelopes().find((envelope) => envelope.type === "ping");
    expect(p2pPing).toBeTruthy();
    webrtc.inject(pongFor(webrtc, p2pPing!));
    await flush();
    expect(manager.getSnapshot().status).toBe("mqtt");
    vi.advanceTimersByTime(3000);
    manager.probeNow();
    await flush();
    expect(manager.getSnapshot().status).toBe("p2p");
    expect(manager.getSnapshot().transport).toBe("webrtc");

    webrtc.setState("failed");
    await flush();
    expect(manager.getSnapshot().status).toBe("mqtt");
    expect(changes).toContainEqual(["webrtc", "mqtt"]);

    const sent = await manager.send(createEnvelope("request", sid, { kind: "test" }));
    expect(sent).toBe("mqtt");
    expect(mqtt.envelopes().at(-1)?.type).toBe("request");
    manager.stop();
  });

  it("reports offline when both transports are gone", async () => {
    const mqtt = new FakeTransport("mqtt");
    const manager = new TransportManager({
      sessionId: sid,
      clientId: null,
      serverId: "server-1",
      transports: { mqtt },
      security: identitySecurity,
    });
    manager.start();
    mqtt.setState("open");
    await flush();
    const ping = mqtt.envelopes().find((envelope) => envelope.type === "ping");
    mqtt.inject(pongFor(mqtt, ping!));
    await flush();
    expect(manager.getSnapshot().status).toBe("mqtt");
    mqtt.setState("failed");
    await flush();
    expect(manager.getSnapshot().status).toBe("offline");
    await expect(manager.send(createEnvelope("request", sid, null))).rejects.toMatchObject({
      code: "OFFLINE",
    });
    manager.stop();
  });

  it("drops tampered or foreign-session frames", async () => {
    const mqtt = new FakeTransport("mqtt");
    const manager = new TransportManager({
      sessionId: sid,
      clientId: null,
      serverId: "server-1",
      transports: { mqtt },
      security: {
        sessionId: sid,
        seal: async (_kind, plaintext) => plaintext,
        open: async (_kind, frame) => {
          const decoded = new TextDecoder().decode(frame);
          if (decoded.includes("tamper")) throw new Error("bad tag");
          return frame;
        },
        destroy: () => undefined,
      },
    });
    const received: Envelope[] = [];
    manager.onEnvelope((envelope) => received.push(envelope));
    manager.start();
    mqtt.setState("open");
    mqtt.inject(new TextEncoder().encode("tamper"));
    mqtt.inject(
      encodeEnvelopeJson(
        createEnvelope("event", "other-session-id", { event: "x", data: 1 }),
        65536,
      ),
    );
    mqtt.inject(encodeEnvelopeJson(createEnvelope("event", sid, { event: "x", data: 1 }), 65536));
    await flush();
    expect(received).toHaveLength(1);
    manager.stop();
  });
});
