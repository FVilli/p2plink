import { P2PLinkError, P2PLinkErrorCodes, type Logger, type Unsubscribe } from "@p2plink/core";
import { generateIdentity, publicKeyFingerprint, validatePublicJwk } from "@p2plink/crypto";
import { MqttConnection } from "@p2plink/mqtt";
import { PairSession } from "./pair.js";
import {
  DEMO_PROTOCOL_VERSION,
  issueTopic,
  issuesInboxTopic,
  makeIssue,
  makeLeave,
  makePresence,
  newPeerId,
  presenceInboxTopic,
  presenceTopic,
  signalInboxTopic,
} from "./topics.js";
import { addTraffic, emptyTraffic } from "./rate.js";
import type {
  HandshakeMessage,
  IssueLevel,
  MeshIssue,
  MeshPeer,
  MeshPeerConfig,
  MeshSnapshot,
  PeerKind,
  PeerStats,
  RemotePeer,
  TrafficDirection,
  TrafficView,
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
  private readonly version: string;
  private readonly logger: Logger;
  private identity: Awaited<ReturnType<typeof generateIdentity>> | null = null;
  private connection: MqttConnection | null = null;
  private readonly peers = new Map<string, RemotePeer>();
  private readonly pairs = new Map<string, PairSession>();
  private readonly listeners = new Set<(snapshot: MeshSnapshot) => void>();
  private readonly recentIssues: MeshIssue[] = [];
  private readonly issueIds = new Set<string>();
  private readonly issueDedupe = new Map<string, number>();
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
    this.version = config.version ?? "0.0.0";
    this.logger = config.logger ?? consoleLogger;
    this.webRtcEnabled = !config.disableWebRtc;
    this.lastSnapshot = {
      self: { peerId: this.peerId, name: config.name, kind: config.kind, version: this.version },
      brokerConnected: false,
      webRtcEnabled: this.webRtcEnabled,
      peers: [],
      totals: {
        peers: 0,
        p2pBytes: 0,
        mqttBytes: 0,
        p2pMessages: 0,
        mqttMessages: 0,
        p2pBytesPerSec: 0,
        mqttBytesPerSec: 0,
        traffic: emptyTraffic(),
      },
      recentIssues: [],
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
      will: {
        topic: presenceTopic(this.peerId),
        // Empty retained payload clears the stale presence on abnormal disconnect.
        payload: new Uint8Array(0),
        qos: 1,
        retain: true,
      },
      logger: this.logger,
    });
    this.connection = connection;
    try {
      await connection.connect();
      await connection.subscribeAsync(
        presenceInboxTopic(),
        (topic, payload) => {
          this.handlePresencePayload(topic, payload);
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
      await connection
        .subscribeAsync(
          issuesInboxTopic(),
          (topic, payload) => {
            this.handleIssuePayload(topic, payload);
          },
          1,
        )
        .catch((error: unknown) => {
          // A restrictive broker ACL must not prevent the mesh from starting.
          this.logger.warn("issue subscription unavailable", {
            error: P2PLinkError.from(error).message,
          });
        });
    } catch (error) {
      const normalized = P2PLinkError.from(error);
      await connection.close().catch(() => undefined);
      this.connection = null;
      this.reportIssue("error", "mesh start failed", {
        phase: "mqtt-connect",
        broker: this.safeBroker(),
        online: typeof navigator === "undefined" ? true : navigator.onLine,
        secureContext: typeof window === "undefined" ? true : window.isSecureContext,
        ...(this.config.platform === undefined ? {} : { platform: this.config.platform }),
      });
      throw normalized;
    }
    this.started = true;
    this.stopped = false;
    await this.publishPresence();
    const presenceInterval = this.config.presenceIntervalMs ?? 30_000;
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
      version: this.version,
      pingBytes: this.config.pingBytes,
      presenceIntervalMs: presenceInterval,
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
        const topic = presenceTopic(this.peerId);
        await this.connection.publish(
          topic,
          JSON.stringify(makeLeave(this.peerId, this.config.name, this.config.kind, this.version)),
          1,
        );
        await this.connection.publish(topic, new Uint8Array(0), 1, { retain: true });
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

  reportIssue(
    level: IssueLevel,
    message: string,
    context: Record<string, string | number | boolean> = {},
  ): void {
    const key = `${level}:${message}:${JSON.stringify(context)}`;
    const now = Date.now();
    const previous = this.issueDedupe.get(key);
    if (previous !== undefined && now - previous < 30_000) return;
    this.issueDedupe.set(key, now);
    if (this.issueDedupe.size > 200) {
      for (const [entryKey, at] of this.issueDedupe) {
        if (now - at > 60_000) this.issueDedupe.delete(entryKey);
      }
    }
    const issue = makeIssue({
      id: newPeerId(),
      peerId: this.peerId,
      name: this.config.name,
      kind: this.config.kind,
      version: this.version,
      level,
      message,
      context: this.sanitizeContext(context),
    });
    this.recordIssue(issue);
    if (this.connection?.state === "open") {
      void this.connection
        .publish(issueTopic(this.peerId), JSON.stringify(issue), 1)
        .catch((error: unknown) => {
          this.logger.debug("issue publish failed", {
            error: P2PLinkError.from(error).message,
          });
        });
    } else {
      void this.publishIssueStandalone(issue);
    }
  }

  private safeBroker(): string {
    try {
      const parsed = new URL(this.config.url);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      return "invalid-url";
    }
  }

  private sanitizeContext(
    context: Record<string, string | number | boolean>,
  ): Record<string, string | number | boolean> {
    const clean: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(context).slice(0, 20)) {
      if (typeof value === "string") clean[key.slice(0, 40)] = value.slice(0, 300);
      else if (typeof value === "number" && Number.isFinite(value)) clean[key.slice(0, 40)] = value;
      else if (typeof value === "boolean") clean[key.slice(0, 40)] = value;
    }
    return clean;
  }

  private recordIssue(issue: MeshIssue): void {
    if (this.issueIds.has(issue.id)) return;
    this.issueIds.add(issue.id);
    this.recentIssues.unshift(issue);
    if (this.recentIssues.length > 30) {
      const removed = this.recentIssues.pop();
      if (removed) this.issueIds.delete(removed.id);
    }
    this.emitSnapshot();
  }

  private async publishIssueStandalone(issue: MeshIssue): Promise<void> {
    let connection: MqttConnection | null = null;
    try {
      connection = new MqttConnection({
        url: this.config.url,
        clientId: `issue-${this.peerId}-${Date.now()}`,
        ...(this.config.username === undefined ? {} : { username: this.config.username }),
        ...(this.config.password === undefined ? {} : { password: this.config.password }),
        keepaliveSeconds: 15,
        reconnectPeriodMs: 0,
        connectTimeoutMs: 5_000,
        maxPayloadBytes: MAX_FRAME_BYTES,
        logger: this.logger,
      });
      await connection.connect();
      await connection.publish(issueTopic(this.peerId), JSON.stringify(issue), 1);
    } catch (error) {
      this.logger.debug("standalone issue publish failed", {
        error: P2PLinkError.from(error).message,
      });
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  private handleIssuePayload(topic: string, payload: Uint8Array): void {
    const topicPeer = /\/issues\/([^/]+)$/u.exec(topic)?.[1];
    if (!topicPeer) return;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    } catch {
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Partial<MeshIssue>;
    if (
      record.v !== 2 ||
      record.type !== "issue" ||
      typeof record.id !== "string" ||
      record.peerId !== topicPeer ||
      (record.level !== "warn" && record.level !== "error") ||
      typeof record.message !== "string" ||
      typeof record.peerId !== "string" ||
      typeof record.name !== "string" ||
      typeof record.version !== "string" ||
      (record.kind !== "browser" && record.kind !== "nest") ||
      typeof record.ts !== "number"
    ) {
      return;
    }
    const issue: MeshIssue = {
      v: 2,
      type: "issue",
      id: record.id.slice(0, 64),
      peerId: record.peerId.slice(0, 64),
      name: record.name.slice(0, 64),
      kind: record.kind,
      version: record.version.slice(0, 32),
      level: record.level,
      message: record.message.slice(0, 300),
      context:
        typeof record.context === "object" && record.context !== null
          ? this.sanitizeContext(record.context as Record<string, string | number | boolean>)
          : {},
      ts: record.ts,
    };
    if (this.issueIds.has(issue.id)) return;
    this.logger.warn("remote issue", {
      peerId: issue.peerId,
      name: issue.name,
      level: issue.level,
      message: issue.message,
      context: issue.context,
    });
    this.recordIssue(issue);
  }

  private presenceTraffic(): TrafficView {
    const traffic = emptyTraffic();
    for (const pair of this.pairs.values()) {
      if (!pair.isClosed) addTraffic(traffic, pair.traffic());
    }
    return traffic;
  }

  private async publishPresence(): Promise<void> {
    if (!this.connection || !this.identity || this.stopped) return;
    if (this.connection.state !== "open") return;
    try {
      await this.connection.publish(
        presenceTopic(this.peerId),
        JSON.stringify(
          makePresence({
            peerId: this.peerId,
            name: this.config.name,
            kind: this.config.kind,
            version: this.version,
            identityId: this.identity.identityId,
            identityPublicKey: this.identity.publicKeyJwk,
            traffic: this.presenceTraffic(),
          }),
        ),
        1,
        { retain: true },
      );
    } catch (error) {
      this.logger.debug("presence publish failed", {
        error: P2PLinkError.from(error).message,
      });
    }
  }

  private handlePresencePayload(topic: string, payload: Uint8Array): void {
    const topicPeer = /\/presence\/([^/]+)$/u.exec(topic)?.[1];
    if (payload.length === 0) {
      if (topicPeer) this.removePeer(topicPeer);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    } catch {
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (record.v !== DEMO_PROTOCOL_VERSION || typeof record.peerId !== "string") return;
    if (!topicPeer || record.peerId !== topicPeer) {
      this.logger.warn("presence peer id does not match topic", {
        topicPeer,
        peerId: record.peerId,
      });
      return;
    }
    if (record.peerId === this.peerId) return;
    const ttl = this.config.peerTtlMs ?? 60_000;
    if (
      record.type === "presence" &&
      (typeof record.ts !== "number" || Date.now() - record.ts > ttl)
    ) {
      return;
    }
    if (record.type === "leave") {
      this.removePeer(record.peerId);
      // Clear retained leave messages left by older clients. This also makes
      // a reconnecting peer disappear immediately from the retained snapshot.
      if (this.connection?.state === "open") {
        void this.connection
          .publish(presenceTopic(record.peerId), new Uint8Array(0), 1, { retain: true })
          .catch(() => undefined);
      }
      return;
    }
    if (
      record.type !== "presence" ||
      typeof record.name !== "string" ||
      (record.kind !== "browser" && record.kind !== "nest") ||
      typeof record.version !== "string" ||
      typeof record.identityId !== "string"
    ) {
      return;
    }
    try {
      validatePublicJwk(record.identityPublicKey as JsonWebKey);
    } catch {
      return;
    }
    const traffic = this.parseTraffic(record.traffic);
    if (!traffic) return;
    const peer: RemotePeer = {
      peerId: record.peerId,
      name: record.name.slice(0, 64),
      kind: record.kind as PeerKind,
      version: record.version.slice(0, 32),
      identityId: record.identityId,
      identityPublicKey: record.identityPublicKey as JsonWebKey,
      lastSeen: Date.now(),
      traffic,
    };
    const existing = this.peers.get(peer.peerId);
    if (existing) {
      void this.identityChanged(existing, peer).then((changed) => {
        if (changed) {
          this.removePeer(peer.peerId);
          this.peers.set(peer.peerId, peer);
          this.ensurePair(peer);
        } else {
          // Keep the same object: PairSession holds a reference to it.
          Object.assign(existing, peer);
          this.ensurePair(existing);
        }
        this.emitSnapshot();
      });
      return;
    }
    this.peers.set(peer.peerId, peer);
    this.ensurePair(peer);
    this.emitSnapshot();
  }

  private parseTraffic(value: unknown): TrafficView | null {
    if (typeof value !== "object" || value === null) return null;
    const input = value as Record<string, unknown>;
    const readCount = (count: unknown): { messages: number; bytes: number } | null => {
      if (typeof count !== "object" || count === null) return null;
      const item = count as Record<string, unknown>;
      if (
        typeof item.messages !== "number" ||
        !Number.isFinite(item.messages) ||
        item.messages < 0 ||
        typeof item.bytes !== "number" ||
        !Number.isFinite(item.bytes) ||
        item.bytes < 0
      ) {
        return null;
      }
      return { messages: Math.floor(item.messages), bytes: Math.floor(item.bytes) };
    };
    const readDirection = (direction: unknown): TrafficDirection | null => {
      if (typeof direction !== "object" || direction === null) return null;
      const item = direction as Record<string, unknown>;
      const p2p = readCount(item.p2p);
      const mqtt = readCount(item.mqtt);
      return p2p && mqtt ? { p2p, mqtt } : null;
    };
    const tx = readDirection(input.tx);
    const rx = readDirection(input.rx);
    return tx && rx ? { tx, rx } : null;
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
      iceServers: this.config.iceServers ?? [],
      pingBytes: this.config.pingBytes,
      pingTimeoutMs: this.config.pingTimeoutMs ?? 4_000,
      logger: this.logger,
      webRtcEnabled: () => this.webRtcEnabled,
      onChange: () => this.emitSnapshot(),
      reportIssue: (level, message, context) => this.reportIssue(level, message, context),
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
    if (payload[0] === 0x02) {
      const pair = this.pairs.get(from);
      if (pair) void pair.handleSignalFrame(payload);
      return;
    }
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
    const ttl = this.config.peerTtlMs ?? 60_000;
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
          version: peer.version,
          route: "connecting",
          rttMs: null,
          p2pBytes: 0,
          mqttBytes: 0,
          p2pMessages: 0,
          mqttMessages: 0,
          p2pBytesPerSec: 0,
          mqttBytesPerSec: 0,
          traffic: emptyTraffic(),
          remoteTraffic: peer.traffic,
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
        acc.p2pMessages += peer.p2pMessages;
        acc.mqttMessages += peer.mqttMessages;
        acc.p2pBytesPerSec += peer.p2pBytesPerSec;
        acc.mqttBytesPerSec += peer.mqttBytesPerSec;
        addTraffic(acc.traffic, peer.traffic);
        return acc;
      },
      {
        peers: peers.length,
        p2pBytes: 0,
        mqttBytes: 0,
        p2pMessages: 0,
        mqttMessages: 0,
        p2pBytesPerSec: 0,
        mqttBytesPerSec: 0,
        traffic: emptyTraffic(),
      },
    );
    this.lastSnapshot = {
      self: {
        peerId: this.peerId,
        name: this.config.name,
        kind: this.config.kind,
        version: this.version,
      },
      brokerConnected: this.connection?.connected ?? false,
      webRtcEnabled: this.webRtcEnabled,
      peers,
      totals,
      recentIssues: this.recentIssues.slice(0, 30),
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
