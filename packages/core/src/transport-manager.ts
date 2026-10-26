import { P2PLinkError, P2PLinkErrorCodes } from "./errors.js";
import { createEnvelope, decodeEnvelopeJson, encodeEnvelopeJson } from "./protocol.js";
import type { Transport, TransportSendOptions, SessionSecurity } from "./transport.js";
import {
  DEFAULT_LIMITS,
  noopLogger,
  type ConnectionSnapshot,
  type ConnectionStatus,
  type HeartbeatLimits,
  type Logger,
  type P2PLinkLimits,
  type SerializedError,
  type TransportKind,
  type TransportState,
  type Unsubscribe,
} from "./types.js";
import { deferred, randomId, type Deferred } from "./util.js";

interface TransportHealth {
  openSince: number | null;
  lastFrameAt: number;
  lastPongAt: number;
  rttMs: number | null;
  decryptFailures: number;
  sendFailures: number;
}

export interface TransportManagerOptions {
  sessionId: string;
  clientId: string | null;
  serverId: string;
  transports: Partial<Record<TransportKind, Transport>>;
  security: SessionSecurity;
  limits?: Partial<HeartbeatLimits & Pick<P2PLinkLimits, "maxFrameBytes">>;
  logger?: Logger;
  now?: () => number;
  idFactory?: () => string;
  onTransportChange?: (from: TransportKind | null, to: TransportKind | null) => void;
  onUnhealthy?: (kind: TransportKind) => void;
}

interface PendingPing {
  kind: TransportKind;
  sentAt: number;
}

const EMPTY_HEALTH: TransportHealth = {
  openSince: null,
  lastFrameAt: 0,
  lastPongAt: 0,
  rttMs: null,
  decryptFailures: 0,
  sendFailures: 0,
};

/**
 * Selects the best usable transport, probes both transports with application
 * heartbeats, and hides fallback/promotion from the RPC layer.
 */
export class TransportManager {
  private readonly sessionId: string;
  private readonly clientId: string | null;
  private readonly serverId: string;
  private readonly transports: Partial<Record<TransportKind, Transport>>;
  private readonly security: SessionSecurity;
  private readonly limits: HeartbeatLimits & Pick<P2PLinkLimits, "maxFrameBytes">;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly onTransportChange:
    | ((from: TransportKind | null, to: TransportKind | null) => void)
    | undefined;
  private readonly onUnhealthy: ((kind: TransportKind) => void) | undefined;

  private readonly health: Record<TransportKind, TransportHealth> = {
    mqtt: { ...EMPTY_HEALTH },
    webrtc: { ...EMPTY_HEALTH },
  };
  private readonly transportUnsubs: Partial<Record<TransportKind, Unsubscribe[]>> = {};
  private readonly pendingPings = new Map<string, PendingPing>();
  private readonly envelopeListeners = new Set<
    (envelope: ReturnType<typeof createEnvelope>, transport: TransportKind) => void
  >();
  private readonly statusListeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  private readonly readyWaiters = new Set<Deferred<void>>();

  private active: TransportKind | null = null;
  private status: ConnectionStatus = "connecting";
  private lastError: SerializedError | null = null;
  private connectedAt: number | null = null;
  private since = Date.now();
  private pendingRequests = 0;
  private webrtcCooldownUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private closed = false;

  constructor(options: TransportManagerOptions) {
    this.sessionId = options.sessionId;
    this.clientId = options.clientId;
    this.serverId = options.serverId;
    this.transports = options.transports;
    this.security = options.security;
    this.limits = {
      heartbeatIntervalMs:
        options.limits?.heartbeatIntervalMs ?? DEFAULT_LIMITS.heartbeatIntervalMs,
      heartbeatTimeoutMs: options.limits?.heartbeatTimeoutMs ?? DEFAULT_LIMITS.heartbeatTimeoutMs,
      promoteAfterMs: options.limits?.promoteAfterMs ?? DEFAULT_LIMITS.promoteAfterMs,
      switchCooldownMs: options.limits?.switchCooldownMs ?? DEFAULT_LIMITS.switchCooldownMs,
      maxPendingPings: options.limits?.maxPendingPings ?? DEFAULT_LIMITS.maxPendingPings,
      maxFrameBytes: options.limits?.maxFrameBytes ?? DEFAULT_LIMITS.maxFrameBytes,
    };
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? randomId;
    this.onTransportChange = options.onTransportChange;
    this.onUnhealthy = options.onUnhealthy;
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    for (const kind of ["mqtt", "webrtc"] as const) this.attachTransport(kind);
    this.timer = setInterval(() => {
      this.heartbeat();
    }, this.limits.heartbeatIntervalMs);
    this.timer.unref?.();
    this.recompute();
    this.emitStatus();
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const kind of ["mqtt", "webrtc"] as const) this.detachTransport(kind);
    for (const waiter of this.readyWaiters) {
      waiter.reject(new P2PLinkError(P2PLinkErrorCodes.CLOSED, "Transport manager closed"));
    }
    this.readyWaiters.clear();
    this.pendingPings.clear();
    this.status = "closed";
    for (const kind of ["mqtt", "webrtc"] as const) {
      const transport = this.transports[kind];
      if (transport) void transport.close().catch(() => undefined);
    }
    this.security.destroy();
    this.recompute();
    this.emitStatus();
  }

  /** Replaces (or removes) a transport without recreating the manager. */
  setTransport(kind: TransportKind, transport: Transport | undefined): void {
    if (this.closed) {
      if (transport) void transport.close().catch(() => undefined);
      return;
    }
    const previous = this.transports[kind];
    this.detachTransport(kind);
    if (transport) this.transports[kind] = transport;
    else delete this.transports[kind];
    this.health[kind] = { ...EMPTY_HEALTH };
    if (previous && previous !== transport) void previous.close().catch(() => undefined);
    if (this.started && transport) this.attachTransport(kind);
    this.recompute();
    this.emitStatus();
  }

  private attachTransport(kind: TransportKind): void {
    const transport = this.transports[kind];
    if (!transport) return;
    const unsubscribers: Unsubscribe[] = [];
    unsubscribers.push(
      transport.onData((data) => {
        void this.handleData(kind, data);
      }),
    );
    unsubscribers.push(
      transport.onStateChange((state) => {
        this.handleState(kind, state);
      }),
    );
    this.transportUnsubs[kind] = unsubscribers;
    this.handleState(kind, transport.state);
  }

  private detachTransport(kind: TransportKind): void {
    for (const unsubscribe of this.transportUnsubs[kind]?.splice(0) ?? []) unsubscribe();
    delete this.transportUnsubs[kind];
  }

  getSnapshot(): ConnectionSnapshot {
    return {
      status: this.status,
      transport: this.active,
      sessionId: this.sessionId,
      clientId: this.clientId,
      serverId: this.serverId,
      rttMs:
        this.active && this.health[this.active].rttMs !== null
          ? this.health[this.active].rttMs
          : null,
      rttByTransport: {
        ...(this.health.mqtt.rttMs === null ? {} : { mqtt: this.health.mqtt.rttMs }),
        ...(this.health.webrtc.rttMs === null ? {} : { webrtc: this.health.webrtc.rttMs }),
      },
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      pendingRequests: this.pendingRequests,
      since: this.since,
    };
  }

  onStatus(listener: (snapshot: ConnectionSnapshot) => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onEnvelope(
    listener: (envelope: ReturnType<typeof createEnvelope>, transport: TransportKind) => void,
  ): Unsubscribe {
    this.envelopeListeners.add(listener);
    return () => this.envelopeListeners.delete(listener);
  }

  setPendingRequests(count: number): void {
    if (this.pendingRequests === count) return;
    this.pendingRequests = count;
    this.emitStatus();
  }

  getActiveTransport(): TransportKind | null {
    return this.active;
  }

  isReady(): boolean {
    return this.active !== null;
  }

  waitForTransport(timeoutMs: number): Promise<void> {
    if (this.active) return Promise.resolve();
    if (this.closed) {
      return Promise.reject(new P2PLinkError(P2PLinkErrorCodes.CLOSED, "Manager is closed"));
    }
    const waiter = deferred<void>();
    this.readyWaiters.add(waiter);
    const timer = setTimeout(() => {
      this.readyWaiters.delete(waiter);
      waiter.reject(
        new P2PLinkError(P2PLinkErrorCodes.TIMEOUT, "Timed out waiting for a usable transport", {
          retryable: true,
        }),
      );
    }, timeoutMs);
    timer.unref?.();
    return waiter.promise.finally(() => {
      clearTimeout(timer);
      this.readyWaiters.delete(waiter);
    });
  }

  async send(envelope: ReturnType<typeof createEnvelope>, options: TransportSendOptions = {}): Promise<TransportKind> {
    const kind = options.via ?? this.active;
    if (!kind) {
      throw new P2PLinkError(P2PLinkErrorCodes.OFFLINE, "No usable transport");
    }
    const transport = this.transports[kind];
    if (!transport || transport.state !== "open") {
      throw new P2PLinkError(
        P2PLinkErrorCodes.TRANSPORT_UNAVAILABLE,
        `Transport ${kind} is not open`,
        { retryable: true },
      );
    }
    try {
      const plaintext = encodeEnvelopeJson(envelope, this.limits.maxFrameBytes);
      const frame = await this.security.seal(kind, plaintext);
      if (frame.length > this.limits.maxFrameBytes) {
        throw new P2PLinkError(
          P2PLinkErrorCodes.PAYLOAD_TOO_LARGE,
          `Sealed frame is ${frame.length} bytes, limit is ${this.limits.maxFrameBytes}`,
        );
      }
      await transport.send(frame);
      return kind;
    } catch (error) {
      const normalized = P2PLinkError.from(error);
      this.health[kind].sendFailures += 1;
      this.lastError = normalized.toJSON();
      this.logger.warn("transport send failed", {
        transport: kind,
        code: normalized.code,
        message: normalized.message,
      });
      if (normalized.code === P2PLinkErrorCodes.PAYLOAD_TOO_LARGE) throw normalized;
      throw new P2PLinkError(
        P2PLinkErrorCodes.TRANSPORT_SEND_FAILED,
        `Failed to send on ${kind}: ${normalized.message}`,
        { retryable: true, outcomeUnknown: true, cause: normalized },
      );
    }
  }

  /** Sends a heartbeat immediately on every open transport. */
  probeNow(): void {
    this.heartbeat();
  }

  private handleState(kind: TransportKind, state: TransportState): void {
    const health = this.health[kind];
    if (state === "open") {
      if (health.openSince === null) {
        health.openSince = this.now();
        health.lastFrameAt = 0;
        health.lastPongAt = 0;
        health.decryptFailures = 0;
        this.logger.info("transport opened", { transport: kind });
        this.sendPing(kind);
      }
    } else {
      const wasOpen = health.openSince !== null;
      health.openSince = null;
      health.lastPongAt = 0;
      health.rttMs = null;
      if (wasOpen || state === "failed") {
        this.logger.warn("transport unavailable", { transport: kind, state });
      }
      if (kind === "webrtc" && state === "closed") {
        this.webrtcCooldownUntil = this.now() + this.limits.switchCooldownMs;
      }
    }
    this.recompute();
    this.emitStatus();
  }

  private heartbeat(): void {
    if (this.closed) return;
    const now = this.now();
    for (const [id, ping] of this.pendingPings) {
      if (now - ping.sentAt > this.limits.heartbeatTimeoutMs) {
        this.pendingPings.delete(id);
        this.health[ping.kind].sendFailures += 1;
        this.logger.warn("heartbeat timed out", { transport: ping.kind });
      }
    }
    for (const kind of ["mqtt", "webrtc"] as const) {
      if (this.transports[kind]?.state === "open") this.sendPing(kind);
    }
    this.recompute();
    this.emitStatus();
  }

  private sendPing(kind: TransportKind): void {
    const transport = this.transports[kind];
    if (!transport || transport.state !== "open") return;
    if (this.pendingPings.size >= this.limits.maxPendingPings) return;
    const envelope = createEnvelope("ping", this.sessionId, null, { id: this.idFactory() });
    this.pendingPings.set(envelope.id, { kind, sentAt: this.now() });
    void this.sendDirect(kind, envelope).catch((error: unknown) => {
      this.pendingPings.delete(envelope.id);
      this.logger.debug("ping send failed", {
        transport: kind,
        error: P2PLinkError.from(error).message,
      });
    });
  }

  private async sendDirect(kind: TransportKind, envelope: ReturnType<typeof createEnvelope>): Promise<void> {
    const transport = this.transports[kind];
    if (!transport || transport.state !== "open") return;
    const plaintext = encodeEnvelopeJson(envelope, this.limits.maxFrameBytes);
    const frame = await this.security.seal(kind, plaintext);
    await transport.send(frame);
  }

  private async handleData(kind: TransportKind, data: Uint8Array): Promise<void> {
    if (this.closed) return;
    let envelope: ReturnType<typeof createEnvelope>;
    try {
      const plaintext = await this.security.open(kind, data);
      envelope = decodeEnvelopeJson(plaintext, this.limits.maxFrameBytes);
    } catch (error) {
      this.health[kind].decryptFailures += 1;
      this.logger.warn("failed to open frame", {
        transport: kind,
        error: P2PLinkError.from(error).message,
      });
      if (this.health[kind].decryptFailures >= 10) {
        this.onUnhealthy?.(kind);
      }
      return;
    }
    if (envelope.sid !== this.sessionId) {
      this.logger.warn("dropping envelope for another session", { transport: kind });
      return;
    }
    const now = this.now();
    this.health[kind].lastFrameAt = now;
    if (envelope.type === "ping") {
      const pong = createEnvelope("pong", this.sessionId, null, {
        id: this.idFactory(),
        cid: envelope.id,
      });
      void this.sendDirect(kind, pong).catch(() => undefined);
      this.recompute();
      this.emitStatus();
      return;
    }
    if (envelope.type === "pong") {
      if (envelope.cid) {
        const ping = this.pendingPings.get(envelope.cid);
        if (ping && ping.kind === kind) {
          this.pendingPings.delete(envelope.cid);
          const rtt = Math.max(0, now - ping.sentAt);
          this.health[kind].rttMs = rtt;
          this.health[kind].lastPongAt = now;
        }
      }
      this.recompute();
      this.emitStatus();
      return;
    }
    this.recompute();
    if (this.active === kind) {
      // Reachability is confirmed by any authenticated frame.
      this.health[kind].lastPongAt = Math.max(this.health[kind].lastPongAt, now);
    }
    this.emitStatus();
    for (const listener of this.envelopeListeners) listener(envelope, kind);
  }

  private recompute(): void {
    if (this.closed) {
      this.status = "closed";
      return;
    }
    const now = this.now();
    const mqttAlive = this.isAlive("mqtt", now);
    const webrtcAlive = this.isAlive("webrtc", now);
    const webrtcStable =
      webrtcAlive &&
      now >= this.webrtcCooldownUntil &&
      this.health.webrtc.openSince !== null &&
      now - this.health.webrtc.openSince >= this.limits.promoteAfterMs;

    let next: TransportKind | null = null;
    if (webrtcStable) next = "webrtc";
    else if (mqttAlive) next = "mqtt";

    if (next !== this.active) {
      const from = this.active;
      this.active = next;
      if (from === "webrtc" && next === "mqtt") {
        this.webrtcCooldownUntil = now + this.limits.switchCooldownMs;
      }
      if (next !== null && this.connectedAt === null) this.connectedAt = now;
      this.logger.info("active transport changed", { from, to: next });
      this.onTransportChange?.(from, next);
      if (next !== null) {
        for (const waiter of this.readyWaiters) waiter.resolve();
        this.readyWaiters.clear();
      }
    }

    const anyOpen = (["mqtt", "webrtc"] as const).some(
      (kind) => this.transports[kind]?.state === "open",
    );
    const anyConnecting = (["mqtt", "webrtc"] as const).some(
      (kind) => this.transports[kind]?.state === "connecting",
    );

    let status: ConnectionStatus;
    if (this.active === "webrtc") status = "p2p";
    else if (this.active === "mqtt") status = "mqtt";
    else if (anyOpen || anyConnecting) status = this.connectedAt !== null ? "reconnecting" : "connecting";
    else status = this.started ? "offline" : "connecting";
    if (status !== this.status) {
      this.status = status;
      this.since = now;
      if (status === "p2p" || status === "mqtt") {
        this.lastError = null;
      }
    }
  }

  private isAlive(kind: TransportKind, now: number): boolean {
    const transport = this.transports[kind];
    if (!transport || transport.state !== "open") return false;
    const health = this.health[kind];
    if (health.lastPongAt === 0) return false;
    return now - health.lastPongAt <= this.limits.heartbeatTimeoutMs;
  }

  private emitStatus(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger.error("status listener failed", { error: P2PLinkError.from(error).message });
      }
    }
  }
}
