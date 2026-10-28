import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:1/unused";
process.env.JWT_SECRET ??= "test-secret-012345678901234567890123";
process.env.MQTT_PUBLIC_URL ??= "ws://127.0.0.1:9001";
process.env.SMTP_HOST ??= "127.0.0.1";
process.env.EMAIL ??= "noreply@example.test";
process.env.EMAIL_SECRET ??= "not-used";

const { PresenceService } = await import("../src/presence/presence.service.js");

describe("PresenceService", () => {
  it("accepts v2 presence payloads", () => {
    const service = new PresenceService();
    const peerId = "peer-1";
    const now = Date.now();

    (service as unknown as { receive: (topic: string, payload: string) => void }).receive(
      `mesh/presence/${peerId}`,
      JSON.stringify({
        v: 2,
        type: "presence",
        peerId,
        name: "Peer",
        kind: "node",
        version: "1.0",
        ts: now,
        traffic: {
          tx: { p2p: { messages: 2, bytes: 12 }, mqtt: { messages: 3, bytes: 18 } },
          rx: { p2p: { messages: 1, bytes: 5 }, mqtt: { messages: 4, bytes: 20 } },
        },
      }),
    );

    expect(service.list()).toEqual([
      {
        peerId,
        name: "Peer",
        kind: "node",
        version: "1.0",
        lastSeen: now,
        traffic: {
          p2p: { tx: { messages: 2, bytes: 12 }, rx: { messages: 1, bytes: 5 } },
          mqtt: { tx: { messages: 3, bytes: 18 }, rx: { messages: 4, bytes: 20 } },
        },
      },
    ]);
  });
});
