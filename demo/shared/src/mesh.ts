import { P2PLinkError, P2PLinkErrorCodes, type Logger, type Unsubscribe } from "@p2plink/core";
import { generateIdentity, publicKeyFingerprint, validatePublicJwk } from "@p2plink/crypto";
import { MqttConnection } from "@p2plink/mqtt";
import { PairSession } from "./pair.js";
import {
  DEMO_PROTOCOL_VERSION,
  makeLeave,
  makePresence,
  newPeerId,
  presenceTopic,
  signalInboxTopic,
} from "./topics.js";
import type {
  HandshakeMessage,
  MeshPeer,
  MeshPeerConfig,
  MeshSnapshot,
  PeerKind,
  PeerStats,
  RemotePeer,
} from "./types.js";

const MAX_PING_BYTES = 60_000;
const MAX_FRAME_BYTES = 262_144;

const consoleLogger: Logger = {
  debug: (message, meta) => console.debug(`[mesh] ${message}`, meta ?? ""),
  info: (message, meta) => console.info(`[mesh] ${message}`, meta ?? ""),
  warn: (message, meta) => console.warn(`[mesh] ${message}`, meta ?? ""),
  error: (message, meta) => console.error(`[mesh] ${message}`, meta ?? ""),
};

class MeshImpl implements MeshPeer {
  readonly peerId = newPeerId();
  private readonly config: MeshPeerConfig;
  private readonly logger: Logger;
  private identity: Awaited<ReturnType<typeof generateIdentity>> | null = null;
  private connection: MqttConnection | null = null;
  private readonly peers = new Map<string, RemotePeer>();
  private readonly pairs = new Map<string, PairSession>();
  private readonly listeners = new Set<(snapshot: MeshSnapshot) => void>();
  private started = false;
  private stopped = false;
  private webRtcEnabled: boolean;
  private pingCursor = 0;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshot: MeshSnapshot;

  constructor(config: MeshPeerConfig) {
    this.config = config;
    this.logger = config.logger ?? consoleLogger;
    this.webRtcEnabled = !config.disableWebRtc;
    this.lastSnapshot = {
      self: { peerId: this.peerId, name: config.name, kind: config.kind },
      brokerConnected: false,
      webRtcEnabled: this.webRtcEnabled,
      peers: [],
      totals: { peers: 0, p2pBytes: 0, mqttBytes: 0, p2pBytesPerSec: 0, mqttBytesPerSec: 0 },
      updatedAt: Date.now(),
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (
      !Number.isInteger(this.config.pingBytes) ||
      this.config.pingBytes < 1 ||
      this.config.pingBytes > MAX_PING_BYTES
    ) {
      throw new P2PLinkError(
        P2PLinkErrorCodes.INVALID_CONFIG,
        `pingBytes must be between 1 and ${MAX_PING_BYTES}`,
      );
    }
    this.identity = await generateIdentity(this.peerId);
    const connection = new MqttConnection({
      url: this.config.url,
      clientId: this.config.clientId ?? `demo-${this.peerId}`,
      ...(this.config.username === undefined ? {} : { username: this.config.username }),
      ...(this.config.password === undefined ? {} : { password: this.config.password }),
      keepaliveSeconds: 30,
      reconnectPeriodMs: 1_000,
      connectTimeoutMs: 10_000,
      maxPayloadBytes: MAX_FRAME_BYTES,
      logger: this.logger,
    });
    this.connection = connection;
    try {
      await connection.connect();
      await connection.subscribeAsync(
        presenceTopic(),
        (_topic, payload) => {
          this.handlePresencePayload(payload);
        },
        1,
      );
      await connection.subscribeAsync(
        signalInboxTopic(this.peerId),
        (topic, payload) => {
          this.handleSignalPayload(topic, payload);
        },
        1,
      );
    } catch (error) {
      await connection.close().catch(() => undefined);
      this.connection = null;
      throw P2PLinkError.from(error);
    }
    this.started = true;
    this.stopped = false;
    await this.publishPresence();
    const presenceInterval = this.config.presenceIntervalMs ?? 2_000;
    this.presenceTimer = setInterval(() => {
      void this.publishPresence();
    }, presenceInterval);
    this.pruneTimer = setInterval(() => {
      this.prunePeers();
    }, 2_000);
    this.pingTimer = setInterval(() => {
      this.pingNextPeer();
    }, this.config.pingIntervalMs ?? 250);
    this.statsTimer = setInterval(() => {
      this.emitSnapshot();
    }, 500);
    this.presenceTimer.unref?.();
    this.pruneTimer.unref?.();
    this.pingTimer.unref?.();
    this.statsTimer.unref?.();
    this.logger.info("mesh started", {
      peerId: this.peerId,
      name: this.config.name,
      kind: this.config.kind,
      pingBytes: this.config.pingBytes,
    });
    this.emitSnapshot();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    for (const timer of [this.presenceTimer, this.pruneTimer, this.pingTimer, this.statsTimer]) {
      if (timer) clearInterval(timer);
    }
    this.presenceTimer = null;
    this.pruneTimer = null;
    this.pingTimer = null;
    this.statsTimer = null;
    try {
      if (this.connection?.connected && this.identity) {
        await this.connection.publish(
          presenceTopic(),
          JSON.stringify(makeLeave(this.peerId, this.config.name, this.config.kind)),
          1,
        );
      }
    } catch {
      // Best effort.
    }
    for (const pair of this.pairs.values()) pair.close("mesh-stop");
    this.pairs.clear();
    this.peers.clear();
    await this.connection?.close();
    this.connection = null;
    this.emitSnapshot();
  }

  getSnapshot(): MeshSnapshot {
    return this.lastSnapshot;
  }

  onSnapshot(listener: (snapshot: MeshSnapshot) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.lastSnapshot);
    return () => this.listeners.delete(listener);
  }

  setWebRtcEnabled(enabled: boolean): void {
    this.webRtcEnabled = enabled;
    for (const pair of this.pairs.values()) pair.setWebRtcEnabled(enabled);
    this.emitSnapshot();
  }

  resetStats(): void {
    for (const pair of this.pairs.values()) pair.resetStats();
    this.emitSnapshot();
  }

  private async publishPresence(): Promise<void> {
    if (!this.connection || !this.identity || this.stopped) return;
    if (this.connection.state !== "open") return;
    try {
      await this.connection.publish(
        presenceTopic(),
        JSON.stringify(
          makePresence({
            peerId: this.peerId,
            name: this.config.name,
            kind: this.config.kind,
            identityId: this.identity.identityId,
            identityPublicKey: this.identity.publicKeyJwk,
          }),
        ),
        0,
      );
    } catch (error) {
      this.logger.debug("presence publish failed", {
        error: P2PLinkError.from(error).message,
      });
    }
  }

  private handlePresencePayload(payload: Uint8Array): void {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    } catch {
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (record.v !== DEMO_PROTOCOL_VERSION || typeof record.peerId !== "string") return;
    if (record.peerId === this.peerId) return;
    if (record.type === "leave") {
      this.removePeer(record.peerId);
      return;
    }
    if (
      record.type !== "presence" ||
      typeof record.name !== "string" ||
      (record.kind !== "browser" && record.kind !== "nest") ||
      typeof record.identityId !== "string"
    ) {
      return;
    }
    try {
      validatePublicJwk(record.identityPublicKey as JsonWebKey);
    } catch {
      return;
    }
    const peer: RemotePeer = {
      peerId: record.peerId,
      name: record.name.slice(0, 64),
      kind: record.kind as PeerKind,
      identityId: record.identityId,
      identityPublicKey: record.identityPublicKey as JsonWebKey,
      lastSeen: Date.now(),
    };
    const existing = this.peers.get(peer.peerId);
    if (existing) {
      void this.identityChanged(existing, peer).then((changed) => {
        if (changed) this.removePeer(peer.peerId);
        this.peers.set(peer.peerId, peer);
        this.ensurePair(peer);
        this.emitSnapshot();
      });
      return;
    }
    this.peers.set(peer.peerId, peer);
    this.ensurePair(peer);
    this.emitSnapshot();
  }

  private async identityChanged(existing: RemotePeer, next: RemotePeer): Promise<boolean> {
    const a = await publicKeyFingerprint(existing.identityPublicKey);
    const b = await publicKeyFingerprint(next.identityPublicKey);
    return a !== b;
  }

  private ensurePair(peer: RemotePeer): void {
    if (this.stopped || !this.started) return;
    let pair = this.pairs.get(peer.peerId);
    if (pair?.isClosed) {
      this.pairs.delete(peer.peerId);
      pair = undefined;
    }
    if (pair) {
      pair.ensureProgress();
      return;
    }
    const role = this.peerId < peer.peerId ? "initiator" : "responder";
    pair = this.createPair(peer, role);
    if (role === "initiator") pair.start();
  }

  private createPair(peer: RemotePeer, role: "initiator" | "responder"): PairSession {
    if (!this.connection || !this.identity) {
      throw new P2PLinkError(P2PLinkErrorCodes.OFFLINE, "mesh is not started");
    }
    const pair = new PairSession({
      self: { peerId: this.peerId, name: this.config.name, kind: this.config.kind },
      remote: peer,
      role,
      connection: this.connection,
      identity: this.identity,
      engine: this.config.engine,
      pingBytes: this.config.pingBytes,
      pingTimeoutMs: this.config.pingTimeoutMs ?? 4_000,
      logger: this.logger,
      webRtcEnabled: () => this.webRtcEnabled,
      onChange: () => this.emitSnapshot(),
    });
    this.pairs.set(peer.peerId, pair);
    return pair;
  }

  private handleSignalPayload(topic: string, payload: Uint8Array): void {
    const match = /\/signal\/([^/]+)\/([^/]+)$/u.exec(topic);
    if (!match) return;
    const to = match[1];
    const from = match[2];
    if (to !== this.peerId || !from || from === this.peerId) return;
    const peer = this.peers.get(from);
    if (!peer) return;
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const handshake = message as Partial<HandshakeMessage>;
    if (handshake.v !== 1 || handshake.type !== "handshake") return;
    let pair = this.pairs.get(from);
    if (!pair) {
      const helloKind =
        typeof handshake.hello === "object" && handshake.hello !== null
          ? (handshake.hello as { kind?: unknown }).kind
          : null;
      const expectedRole = this.peerId < from ? "initiator" : "responder";
      if (helloKind !== "client-hello" || expectedRole !== "responder") {
        return;
      }
      pair = this.createPair(peer, "responder");
    }
    void pair.handleHandshake(message);
  }

  private removePeer(peerId: string): void {
    const pair = this.pairs.get(peerId);
    if (pair) pair.close("peer-left");
    this.pairs.delete(peerId);
    if (this.peers.delete(peerId)) this.emitSnapshot();
  }

  private prunePeers(): void {
    const ttl = this.config.peerTtlMs ?? 6_000;
    const cutoff = Date.now() - ttl;
    for (const [peerId, peer] of this.peers) {
      if (peer.lastSeen < cutoff) {
        this.logger.info("peer expired", { peerId, name: peer.name });
        this.removePeer(peerId);
      }
    }
  }

  private pingNextPeer(): void {
    if (this.stopped) return;
    const pairs = [...this.pairs.values()].filter((pair) => pair.canPing());
    if (pairs.length === 0) return;
    for (let i = 0; i < pairs.length; i += 1) {
      const index = (this.pingCursor + i) % pairs.length;
      const pair = pairs[index]!;
      if (pair.canPing()) {
        this.pingCursor = (index + 1) % pairs.length;
        void pair.sendPing();
        return;
      }
    }
  }

  private emitSnapshot(): void {
    const now = Date.now();
    const peers: PeerStats[] = [];
    for (const peer of this.peers.values()) {
      const pair = this.pairs.get(peer.peerId);
      if (pair && !pair.isClosed) {
        peers.push(pair.snapshot(now));
      } else {
        peers.push({
          peerId: peer.peerId,
          name: peer.name,
          kind: peer.kind,
          route: "connecting",
          rttMs: null,
          p2pBytes: 0,
          mqttBytes: 0,
          p2pBytesPerSec: 0,
          mqttBytesPerSec: 0,
          pings: 0,
          roundTrips: 0,
          lastPingAt: null,
          lastError: null,
        });
      }
    }
    peers.sort((a, b) => a.name.localeCompare(b.name) || a.peerId.localeCompare(b.peerId));
    const totals = peers.reduce(
      (acc, peer) => {
        acc.p2pBytes += peer.p2pBytes;
        acc.mqttBytes += peer.mqttBytes;
        acc.p2pBytesPerSec += peer.p2pBytesPerSec;
        acc.mqttBytesPerSec += peer.mqttBytesPerSec;
        return acc;
      },
      { peers: peers.length, p2pBytes: 0, mqttBytes: 0, p2pBytesPerSec: 0, mqttBytesPerSec: 0 },
    );
    this.lastSnapshot = {
      self: { peerId: this.peerId, name: this.config.name, kind: this.config.kind },
      brokerConnected: this.connection?.connected ?? false,
      webRtcEnabled: this.webRtcEnabled,
      peers,
      totals,
      updatedAt: now,
    };
    for (const listener of this.listeners) {
      try {
        listener(this.lastSnapshot);
      } catch (error) {
        this.logger.error("snapshot listener failed", {
          error: P2PLinkError.from(error).message,
        });
      }
    }
  }
}

export function createMeshPeer(config: MeshPeerConfig): MeshPeer {
  return new MeshImpl(config);
}
