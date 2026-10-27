import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken, sessionTopics } from "@p2plink/core";
import { MqttConnection } from "../connection.js";
import { MqttServerEndpoint } from "../server-endpoint.js";
import { MqttSessionEndpoint } from "../session-endpoint.js";

const url = process.env.P2PLINK_BROKER_URL ?? "mqtt://127.0.0.1:1883";
const tenant = "mqtt-itest";
const serverId = "mqtt-server-1";
const clientId = "client-test-1";

describe("MQTT endpoints against a real broker", () => {
  const suffix = randomToken(4);
  let server: MqttConnection;
  let client: MqttConnection;
  let serverEndpoint: MqttServerEndpoint;
  let clientEndpoint: MqttSessionEndpoint;

  beforeAll(async () => {
    server = new MqttConnection({
      url,
      username: "p2plink-server",
      password: "server-dev-password",
      clientId: `srv-${suffix}`,
    });
    client = new MqttConnection({
      url,
      username: clientId,
      password: "client1-dev-password",
      clientId: `cli-${suffix}`,
    });
    await server.connect();
    await client.connect();
    serverEndpoint = new MqttServerEndpoint(server, { tenant, serverId });
    await serverEndpoint.start();
    clientEndpoint = new MqttSessionEndpoint(client, sessionTopics({ tenant, serverId, clientId }));
    await clientEndpoint.start();
  }, 20_000);

  afterAll(async () => {
    await clientEndpoint?.close();
    await serverEndpoint?.close();
    await client?.close();
    await server?.close();
  });

  it("routes handshake and binary frames both ways", async () => {
    const handshake = new Promise<[string, unknown]>((resolve) => {
      serverEndpoint.onHandshake((id, message) => resolve([id, message]));
    });
    await clientEndpoint.sendHandshake({ kind: "client-hello", sessionId: "s".repeat(16) });
    await expect(handshake).resolves.toEqual([
      clientId,
      { kind: "client-hello", sessionId: "s".repeat(16) },
    ]);

    const serverClient = serverEndpoint.forClient(clientId);
    const inbound = new Promise<Uint8Array>((resolve) => serverClient.onFrame(resolve));
    const outbound = new Promise<Uint8Array>((resolve) => clientEndpoint.onFrame(resolve));
    const frame = new Uint8Array([2, 1, 9, 8, 7, 6]);
    await clientEndpoint.sendFrame(frame);
    expect(Array.from(await inbound)).toEqual(Array.from(frame));
    await serverClient.sendFrame(frame);
    expect(Array.from(await outbound)).toEqual(Array.from(frame));
  }, 15_000);

  it("enforces broker ACL isolation at delivery time", async () => {
    const intruder = new MqttConnection({
      url,
      username: clientId,
      password: "client1-dev-password",
      clientId: `intruder-${suffix}`,
    });
    await intruder.connect();
    try {
      const otherTopics = sessionTopics({ tenant, serverId, clientId: "client-test-2" });
      let leaked = false;
      // Mosquitto may grant the subscription and enforce ACL on delivery.
      await intruder.subscribeAsync(
        otherTopics.sessionS2c,
        () => {
          leaked = true;
        },
        1,
      );
      await serverEndpoint.publishToClient("client-test-2", new Uint8Array([2, 1, 1, 1]));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(leaked).toBe(false);
    } finally {
      await intruder.close();
    }
  }, 15_000);
});
