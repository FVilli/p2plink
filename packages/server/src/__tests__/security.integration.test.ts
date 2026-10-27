import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  P2PLinkError,
  P2PLinkErrorCodes,
  randomToken,
  type BootstrapRequest,
  type BootstrapResult,
} from "@p2plink/core";
import { generateIdentity, type IdentityKeyPair } from "@p2plink/crypto";
import { createNodeWebRtcEngine } from "@p2plink/webrtc/node";
import { MqttConnection } from "@p2plink/mqtt";
import {
  createP2PLinkClient,
  staticBootstrapProvider,
  type P2PLinkClient,
} from "@p2plink/client/node";
import { P2PLinkServer } from "../server.js";

const brokerUrl = process.env.P2PLINK_BROKER_URL ?? "mqtt://127.0.0.1:1883";
const suffix = randomToken(4);
const serverId = "security-server";
const tenant = "security";

interface Rpc {
  echo: { request: { value: string }; response: { value: string } };
}

describe("security boundaries", () => {
  let server: P2PLinkServer;
  let identityOne: IdentityKeyPair;
  let identityTwo: IdentityKeyPair;
  const clients: P2PLinkClient<Rpc, Record<string, never>>[] = [];

  async function bootstrapFor(identity: IdentityKeyPair, token: string): Promise<BootstrapResult> {
    const request: BootstrapRequest = {
      protocolVersion: 1,
      clientId: token === "token-1" ? "client-test-1" : "client-test-2",
      tenant,
      serverId,
      identityId: identity.identityId,
      identityPublicKey: identity.publicKeyJwk,
      requestId: randomToken(8),
    };
    const response = await server.handleBootstrap({
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: request,
    });
    expect(response.status).toBe(200);
    return response.body as BootstrapResult;
  }

  function clientFor(
    identity: IdentityKeyPair,
    bootstrap: BootstrapResult,
    maxPayloadBytes = 64 * 1024,
  ): P2PLinkClient<Rpc, Record<string, never>> {
    const client = createP2PLinkClient<Rpc, Record<string, never>>({
      serverId,
      tenant,
      clientId: bootstrap.clientId,
      bootstrap: staticBootstrapProvider(bootstrap),
      security: { identity },
      webrtc: {
        engine: createNodeWebRtcEngine(),
        iceServers: [],
        reconnect: { baseDelayMs: 100, maxDelayMs: 300, maxAttempts: 3 },
      },
      limits: {
        heartbeatIntervalMs: 500,
        heartbeatTimeoutMs: 2_000,
        promoteAfterMs: 500,
        requestTimeoutMs: 4_000,
        maxPayloadBytes,
      },
    });
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    identityOne = await generateIdentity("client-1");
    identityTwo = await generateIdentity("client-2");
    server = new P2PLinkServer({
      serverId,
      tenant,
      identity: await generateIdentity("security-server"),
      bootstrap: {
        authenticator: {
          async authenticate({ authorization }) {
            if (authorization === "Bearer token-1") {
              return { subject: "user-1", clientId: "client-test-1" };
            }
            if (authorization === "Bearer token-2") {
              return { subject: "user-2", clientId: "client-test-2" };
            }
            throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "bad token");
          },
        },
        mqttCredentials: async ({ clientId }) => ({
          url: brokerUrl,
          username: clientId,
          password: clientId === "client-test-1" ? "client1-dev-password" : "client2-dev-password",
        }),
      },
      mqtt: {
        url: brokerUrl,
        username: "p2plink-server",
        password: "server-dev-password",
        clientId: `security-srv-${suffix}`,
      },
      webrtc: { enabled: true, engine: createNodeWebRtcEngine(), iceServers: [] },
      limits: {
        heartbeatIntervalMs: 500,
        heartbeatTimeoutMs: 2_000,
        requestTimeoutMs: 4_000,
        sessionIdleTimeoutMs: 30_000,
      },
    });
    server.register("echo", (request) => request as { value: string });
    await server.start();
  }, 30_000);

  afterAll(async () => {
    for (const client of clients) await client.disconnect().catch(() => undefined);
    await server.stop();
  });

  it("rejects an invalid application credential at bootstrap", async () => {
    const response = await server.handleBootstrap({
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: {
        protocolVersion: 1,
        clientId: "client-test-1",
        tenant,
        serverId,
        identityId: "x",
        identityPublicKey: identityOne.publicKeyJwk,
        requestId: "r",
      },
    });
    expect(response.status).toBe(401);
  });

  it("rejects capability replay and tampered capabilities", async () => {
    const bootstrap = await bootstrapFor(identityOne, "token-1");

    const first = clientFor(identityOne, bootstrap);
    await first.connect();
    expect(first.getStatus().status).toBe("mqtt");

    const replay = clientFor(identityOne, bootstrap);
    await expect(replay.connect()).rejects.toBeInstanceOf(P2PLinkError);

    const tampered = await bootstrapFor(identityTwo, "token-2");
    const parts = tampered.capability.split(".");
    const signature = parts[2] ?? "";
    const flipped = `${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
    const tamperedBootstrap: BootstrapResult = {
      ...tampered,
      capability: `${parts[0]}.${parts[1]}.${flipped}`,
    };
    const attacker = clientFor(identityTwo, tamperedBootstrap);
    await expect(attacker.connect()).rejects.toBeInstanceOf(P2PLinkError);
  }, 60_000);

  it("serializes concurrent handshakes for the same client", async () => {
    const firstBootstrap = await bootstrapFor(identityOne, "token-1");
    const secondBootstrap = await bootstrapFor(identityOne, "token-1");
    const agentA = clientFor(identityOne, firstBootstrap);
    const agentB = clientFor(identityOne, secondBootstrap);
    await Promise.allSettled([agentA.connect(), agentB.connect()]);
    const sessions = server
      .getSessionInfo()
      .filter((session) => session.clientId === "client-test-1");
    expect(sessions).toHaveLength(1);
  }, 30_000);

  it("ignores a forged session reset", async () => {
    const bootstrap = await bootstrapFor(identityTwo, "token-2");
    const client = clientFor(identityTwo, bootstrap);
    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const publisher = new MqttConnection({
      url: brokerUrl,
      username: "p2plink-server",
      password: "server-dev-password",
      clientId: `forger-${suffix}`,
    });
    await publisher.connect();
    try {
      await publisher.publish(
        `p2plink/v1/${tenant}/${serverId}/signal/client-test-2/s2c`,
        JSON.stringify({
          v: 1,
          kind: "session-reset",
          clientId: "client-test-2",
          reason: "forged",
          issuedAt: Date.now(),
          signature: "AAAA",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(client.getStatus().status).not.toBe("offline");
      expect(client.getStatus().status).not.toBe("reconnecting");
    } finally {
      await publisher.close();
      await client.disconnect();
    }
  }, 30_000);

  it("rejects oversized application payloads before transmission", async () => {
    const bootstrap = await bootstrapFor(identityTwo, "token-2");
    const client = clientFor(identityTwo, bootstrap, 128);
    await client.connect();
    await expect(client.request("echo", { value: "x".repeat(1_000) })).rejects.toMatchObject({
      code: P2PLinkErrorCodes.PAYLOAD_TOO_LARGE,
    });
    await client.disconnect();
  }, 30_000);
});
