import { describe, expect, it } from "vitest";
import { P2PLinkError, P2PLinkErrorCodes, randomToken, type BootstrapResult } from "@p2plink/core";
import { generateIdentity } from "@p2plink/crypto";
import { createNodeWebRtcEngine } from "@p2plink/webrtc/node";
import { createP2PLinkClient } from "@p2plink/client/node";
import { P2PLinkServer } from "../server.js";

const brokerUrl = process.env.P2PLINK_BROKER_URL ?? "mqtt://127.0.0.1:1883";
const suffix = randomToken(4);

interface TestRpc {
  "math.add": {
    request: { a: number; b: number };
    response: { sum: number; subject: string; role?: string };
  };
  "counter.increment": {
    request: void;
    response: { count: number };
  };
}

interface TestEvents {
  notice: { text: string };
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("P2PLink server/client over a real broker", () => {
  it("authenticates, prefers WebRTC, falls back to MQTT and restores P2P", async () => {
    const serverIdentity = await generateIdentity("server-1");
    const server = new P2PLinkServer({
      serverId: "server-1",
      tenant: "itest",
      identity: serverIdentity,
      bootstrap: {
        authenticator: {
          async authenticate({ authorization }) {
            if (authorization !== "Bearer good-token") {
              throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "bad token");
            }
            return { subject: "user-1", clientId: "client-test-1", claims: { role: "admin" } };
          },
        },
        mqttCredentials: async ({ clientId }) => ({
          url: brokerUrl,
          username: clientId,
          password: "client1-dev-password",
        }),
      },
      mqtt: {
        url: brokerUrl,
        username: "p2plink-server",
        password: "server-dev-password",
        clientId: `srv-${suffix}`,
      },
      webrtc: {
        enabled: true,
        engine: createNodeWebRtcEngine(),
        iceServers: [],
      },
      limits: {
        heartbeatIntervalMs: 500,
        heartbeatTimeoutMs: 2_000,
        promoteAfterMs: 500,
        requestTimeoutMs: 5_000,
        sessionIdleTimeoutMs: 60_000,
      },
    });
    let counter = 0;
    server.register("math.add", (request, context) => {
      const { a, b } = request as { a: number; b: number };
      return {
        sum: a + b,
        subject: context.identity.subject,
        role: context.identity.claims?.role as string | undefined,
      };
    });
    server.register(
      "counter.increment",
      () => {
        counter += 1;
        return { count: counter };
      },
      { idempotent: true },
    );

    await server.start();
    const client = createP2PLinkClient<TestRpc, TestEvents>({
      serverId: "server-1",
      tenant: "itest",
      clientId: "client-test-1",
      bootstrap: {
        async bootstrap(request) {
          const response = await server.handleBootstrap({
            method: "POST",
            headers: { authorization: "Bearer good-token" },
            body: request,
          });
          if (response.status !== 200) {
            throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "bootstrap rejected");
          }
          return response.body as BootstrapResult;
        },
      },
      mqtt: {
        url: brokerUrl,
        credentials: async () => ({
          username: "client-test-1",
          password: "client1-dev-password",
        }),
      },
      webrtc: {
        engine: createNodeWebRtcEngine(),
        iceServers: [],
        reconnect: { baseDelayMs: 100, maxDelayMs: 500, maxAttempts: 20 },
      },
      limits: {
        heartbeatIntervalMs: 500,
        heartbeatTimeoutMs: 2_000,
        promoteAfterMs: 500,
        requestTimeoutMs: 5_000,
      },
    });

    try {
      await client.connect();
      await waitFor(() => client.getStatus().transport === "webrtc");
      expect(client.getStatus().status).toBe("p2p");

      const sum = await client.request("math.add", { a: 2, b: 3 });
      expect(sum).toEqual({ sum: 5, subject: "user-1", role: "admin" });

      const events: TestEvents["notice"][] = [];
      client.on("notice", (payload) => events.push(payload));
      await server.emitTo("client-test-1", "notice", { text: "hello" });
      await waitFor(() => events.length === 1);
      expect(events[0]).toEqual({ text: "hello" });

      // Idempotent duplicate returns the cached result without re-executing.
      const first = await client.request("counter.increment", undefined, {
        idempotent: true,
        idempotencyKey: "increment-once",
      });
      const second = await client.request("counter.increment", undefined, {
        idempotent: true,
        idempotencyKey: "increment-once",
      });
      expect(first).toEqual({ count: 1 });
      expect(second).toEqual({ count: 1 });

      // Force a P2P failure: the client must continue over MQTT.
      expect(await server.dropP2P("client-test-1")).toBe(true);
      await waitFor(() => client.getStatus().transport === "mqtt");
      expect(await client.request("math.add", { a: 10, b: 5 })).toMatchObject({ sum: 15 });

      // The client renegotiates and returns to WebRTC.
      await waitFor(() => client.getStatus().transport === "webrtc", 25_000);
      expect(await client.request("math.add", { a: 7, b: 8 })).toMatchObject({ sum: 15 });
      expect(server.getSessionInfo()[0]?.transport).toBe("webrtc");
    } finally {
      await client.disconnect();
      await server.stop();
    }
  }, 90_000);
});
