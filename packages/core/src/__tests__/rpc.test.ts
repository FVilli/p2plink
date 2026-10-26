import { describe, expect, it, vi } from "vitest";
import { P2PLinkError, P2PLinkErrorCodes } from "../errors.js";
import { MemoryIdempotencyStore } from "../idempotency.js";
import type { Envelope } from "../protocol-types.js";
import { RpcClient } from "../rpc-client.js";
import { RpcServer } from "../rpc-server.js";
import type { RpcHandlerContext } from "../rpc-server.js";

const sid = "abcdefghijklmnop";

function makePair() {
  const server = new RpcServer({
    idempotency: new MemoryIdempotencyStore(),
    defaultTimeoutMs: 1000,
  });
  const ctx: Omit<RpcHandlerContext, "requestId" | "method" | "signal"> = {
    identity: {
      subject: "user-1",
      identityId: "id-1",
      publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    },
    clientId: "client-1",
    sessionId: sid,
    serverId: "server-1",
    transport: "mqtt",
  };
  const client = new RpcClient<Record<string, { request: unknown; response: unknown }>, {}>({
    sessionId: sid,
    timeoutMs: 1000,
    maxPendingRequests: 8,
    send: async (envelope) => {
      const response = await server.handle(envelope, ctx);
      if (response) queueMicrotask(() => client.handleEnvelope(response));
      return "mqtt";
    },
  });
  return { server, client, ctx };
}

describe("RPC", () => {
  it("routes typed requests and responses", async () => {
    const { server, client } = makePair();
    server.register("users.get", (request) => ({ id: (request as { id: string }).id, name: "Ada" }));
    await expect(
      client.request("users.get", { id: "1" } as never),
    ).resolves.toEqual({ id: "1", name: "Ada" });
  });

  it("returns typed errors", async () => {
    const { server, client } = makePair();
    server.register("boom", () => {
      throw new P2PLinkError(P2PLinkErrorCodes.FORBIDDEN, "nope");
    });
    await expect(client.request("boom", undefined as never)).rejects.toMatchObject({
      code: P2PLinkErrorCodes.FORBIDDEN,
    });
  });

  it("deduplicates retried requests by idempotency key", async () => {
    const { server, client } = makePair();
    let calls = 0;
    server.register("mutate", () => {
      calls += 1;
      return { calls };
    });
    const first = await client.request("mutate", undefined as never, {
      idempotent: true,
      idempotencyKey: "key-1",
    });
    const second = await client.request("mutate", undefined as never, {
      idempotent: true,
      idempotencyKey: "key-1",
    });
    expect(first).toEqual({ calls: 1 });
    expect(second).toEqual({ calls: 1 });
    expect(calls).toBe(1);
  });

  it("times out and reports unknown outcome for mutative requests", async () => {
    const { server, client } = makePair();
    server.register("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return "late";
    });
    await expect(client.request("slow", undefined as never, { timeoutMs: 20 })).rejects.toMatchObject({
      code: P2PLinkErrorCodes.OUTCOME_UNKNOWN,
      outcomeUnknown: true,
    });
  });

  it("retransmits idempotent pending requests on transport change", async () => {
    const sent: Envelope[] = [];
    const client = new RpcClient({
      sessionId: sid,
      timeoutMs: 5000,
      maxPendingRequests: 8,
      send: async (envelope) => {
        sent.push(envelope);
        return "mqtt";
      },
    });
    const promise = client.request("read", undefined as never, { idempotent: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    client.handleTransportChange("mqtt", "webrtc");
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.id).toBe(sent[0]?.id);
    const requestId = sent[0]?.id;
    if (!requestId) throw new Error("missing request id");
    client.handleEnvelope({
      v: 1,
      id: "response-1",
      sid,
      type: "response",
      ts: Date.now(),
      cid: requestId,
      payload: "ok",
    });
    await expect(promise).resolves.toBe("ok");
  });
});
