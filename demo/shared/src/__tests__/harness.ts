import type { Logger } from "@p2plink/core";
import { generateIdentity } from "@p2plink/crypto";
import type { MqttConnection } from "@p2plink/mqtt";
import { PairSession } from "../pair.js";
import { PingRouter } from "../routing.js";
import { dataTopic } from "../topics.js";
import type { MeshPingConfig, RemotePeer } from "../types.js";

type Subscriber = {
  pattern: string;
  callback: (topic: string, payload: string | Uint8Array) => void;
};
export class MemoryMqtt {
  private static readonly subscribers = new Set<Subscriber>();
  private readonly own = new Set<Subscriber>();
  private currentState: "connecting" | "open" = "open";
  private readonly stateListeners = new Set<(state: "connecting" | "open") => void>();
  get state(): "connecting" | "open" {
    return this.currentState;
  }
  get connected(): boolean {
    return this.currentState === "open";
  }
  setState(state: "connecting" | "open"): void {
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }
  async publish(topic: string, payload: string | Uint8Array): Promise<void> {
    for (const subscriber of MemoryMqtt.subscribers) {
      if (matches(subscriber.pattern, topic))
        queueMicrotask(() => subscriber.callback(topic, payload));
    }
  }
  subscribe(
    topic: string,
    callback: (topic: string, payload: string | Uint8Array) => void,
  ): () => void {
    const item = { pattern: topic, callback };
    MemoryMqtt.subscribers.add(item);
    this.own.add(item);
    return () => {
      MemoryMqtt.subscribers.delete(item);
      this.own.delete(item);
    };
  }
  onStateChange(callback: (state: "connecting" | "open") => void): () => void {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }
  async close(): Promise<void> {
    for (const item of this.own) MemoryMqtt.subscribers.delete(item);
    this.own.clear();
  }
}
function matches(pattern: string, topic: string): boolean {
  const a = pattern.split("/");
  const b = topic.split("/");
  return a.length === b.length && a.every((part, i) => part === "+" || part === b[i]);
}
export type TestLogEntry = {
  level?: "debug" | "info";
  message: string;
  context?: Record<string, unknown>;
};
const engine = {} as never;

export async function createPair(
  pingConfig: MeshPingConfig = { bytes: 16, intervalMs: 60_000, concurrency: 1 },
  options: { state?: "connecting" | "open"; transportConfirmTimeoutMs?: number } = {},
) {
  const ids = await Promise.all([generateIdentity("identity-a"), generateIdentity("identity-b")]);
  const connections = [new MemoryMqtt(), new MemoryMqtt()];
  const infoLogs: TestLogEntry[] = [];
  const testLogger: Logger = {
    debug() {},
    info(message, context) {
      infoLogs.push(context === undefined ? { message } : { message, context });
    },
    warn() {},
    error() {},
  };
  if (options.state) for (const connection of connections) connection.setState(options.state);
  const peers = ["mesh-a", "mesh-b"];
  const pairs = [null, null] as unknown as [PairSession, PairSession];
  const routers = peers.map((peer, i) => new PingRouter(peer, () => [pairs[1 - i]!]));
  const pair = (i: number) =>
    new PairSession({
      self: { peerId: peers[i]!, name: peers[i]!, kind: "nest" },
      remote: {
        peerId: peers[1 - i]!,
        name: peers[1 - i]!,
        kind: "nest",
        version: "test",
        identityPublicKey: ids[1 - i]!.publicKeyJwk,
      } as RemotePeer,
      role: i === 0 ? "initiator" : "responder",
      connection: connections[i]! as unknown as MqttConnection,
      identity: ids[i]!,
      engine,
      pingConfig: () => pingConfig,
      pingTimeoutMs: 500,
      ...(options.transportConfirmTimeoutMs === undefined
        ? {}
        : { transportConfirmTimeoutMs: options.transportConfirmTimeoutMs }),
      logger: testLogger,
      webRtcEnabled: () => false,
      router: routers[i]!,
      onChange() {},
      reportIssue() {},
    });
  pairs[0] = pair(0);
  pairs[1] = pair(1);
  const unsubscribers = connections.map((connection, i) =>
    connection.subscribe(`p2plink-demo/v2/signal/${peers[i]}/+`, (_topic, payload) => {
      const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
      void pairs[i]!.handleHandshake(JSON.parse(text));
    }),
  );
  pairs[0].start();
  return {
    pairs,
    connections,
    infoLogs,
    ids,
    async createClientHello(sessionId: string) {
      const { createClientHello } = await import("@p2plink/crypto");
      return createClientHello({
        tenant: "demo",
        serverId: "mesh",
        clientId: "mesh-a",
        sessionId,
        capability: "demo-tofu-capability-0000000000000000",
        identity: ids[0]!,
      });
    },
    dispose() {
      for (const unsubscribe of unsubscribers) unsubscribe();
      for (const p of pairs) p.close();
      for (const c of connections) c.close();
    },
  };
}
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
export function peerDataTopic(peer: string, other: string): string {
  return dataTopic(peer, other);
}
