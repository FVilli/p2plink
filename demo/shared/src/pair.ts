import {
  P2PLinkError,
  P2PLinkErrorCodes,
  TransportManager,
  createEnvelope,
  fromBase64Url,
  randomBytes,
  randomToken,
  sha256Base64Url,
  toBase64Url,
  type Logger,
  type SignalPayload,
  type TransportKind,
} from "@p2plink/core";
import {
  TransportSecurity,
  completeClientHandshake,
  completeServerHandshake,
  createClientHello,
  createServerHello,
  publicKeyFingerprint,
  verifyClientHello,
  type DerivedSession,
  type IdentityKeyPair,
} from "@p2plink/crypto";
import type { MqttConnection } from "@p2plink/mqtt";
import { DemoMqttTransport } from "./transport.js";
import type { WebRtcEngine, WebRtcTransport as WebRtcTransportType } from "@p2plink/webrtc";
import { WebRtcTransport } from "@p2plink/webrtc";
import { RateMeter } from "./rate.js";
import { DEMO_CAPABILITY, DEMO_SERVER_ID, DEMO_TENANT, dataTopic, signalTopic } from "./topics.js";
import type { HandshakeMessage, PairView, PeerKind, PeerRoute, RemotePeer } from "./types.js";

const MAX_FRAME_BYTES = 262_144;
const HANDSHAKE_TIMEOUT_MS = 8_000;
const HANDSHAKE_RETRY_MS = 2_000;
const WEBRTC_RETRY_MS = 2_000;

export interface PairContext {
  self: { peerId: string; name: string; kind: PeerKind };
  remote: RemotePeer;
  role: "initiator" | "responder";
  connection: MqttConnection;
  identity: IdentityKeyPair;
  engine: WebRtcEngine;
  pingBytes: number;
  pingTimeoutMs: number;
  logger: Logger;
  webRtcEnabled: () => boolean;
  onChange: () => void;
}

interface PendingPing {
  id: string;
  envelopeId: string;
  size: number;
  sentAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One demo pair. The lower peerId is always the WebRTC offerer, which removes
 * glare without a central coordinator.
 */
export class PairSession {
  readonly remote: RemotePeer;
  readonly role: "initiator" | "responder";
  private readonly ctx: PairContext;
  private sessionId = randomToken(24);
  private clientState: Awaited<ReturnType<typeof createClientHello>> | null = null;
  private serverState: Awaited<ReturnType<typeof verifyClientHello>> | null = null;
  private security: TransportSecurity | null = null;
  private manager: TransportManager | null = null;
  private mqtt: import("./transport.js").DemoMqttTransport | null = null;
  private webrtc: WebRtcTransportType | null = null;
  private pendingSignals: SignalPayload[] = [];
  private ready = false;
  private closed = false;
  private inFlight: PendingPing | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private webrtcTimer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private route: PeerRoute = "connecting";
  private readonly meter = new RateMeter();
  private pings = 0;
  private rttMs: number | null = null;
  private lastPingAt: number | null = null;
  private lastError: string | null = null;

  constructor(context: PairContext) {
    this.ctx = context;
    this.remote = context.remote;
    this.role = context.role;
  }

  get peerId(): string {
    return this.remote.peerId;
  }

  get isReady(): boolean {
    return this.ready && !this.closed;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  canPing(): boolean {
    return Boolean(
      this.ready &&
      !this.closed &&
      this.manager &&
      !this.inFlight &&
      this.manager.getSnapshot().transport !== null,
    );
  }

  start(): void {
    if (this.role === "initiator") this.startHandshake();
  }

  ensureProgress(): void {
    if (this.closed || this.ready) return;
    if (this.role === "initiator" && !this.handshakeTimer && !this.retryTimer) {
      this.startHandshake();
    }
  }

  private async startHandshake(): Promise<void> {
    if (this.closed || this.ready || this.role !== "initiator") return;
    this.clearTimer("handshake");
    this.clearTimer("retry");
    this.sessionId = randomToken(24);
    try {
      this.clientState = await createClientHello({
        tenant: DEMO_TENANT,
        serverId: DEMO_SERVER_ID,
        clientId: this.ctx.self.peerId,
        sessionId: this.sessionId,
        capability: DEMO_CAPABILITY,
        identity: this.ctx.identity,
      });
      await this.publishHandshake(this.clientState.hello);
      this.handshakeTimer = setTimeout(() => {
        this.handshakeTimer = null;
        this.failHandshake("handshake timeout");
      }, HANDSHAKE_TIMEOUT_MS);
    } catch (error) {
      this.failHandshake(P2PLinkError.from(error).message);
    }
  }

  async handleHandshake(raw: unknown): Promise<void> {
    if (this.closed) return;
    if (typeof raw !== "object" || raw === null) return;
    const message = raw as Partial<HandshakeMessage>;
    if (message.v !== 1 || message.type !== "handshake" || typeof message.sessionId !== "string") {
      return;
    }
    const hello = message.hello;
    if (typeof hello !== "object" || hello === null) return;
    const kind = (hello as { kind?: unknown }).kind;

    if (kind === "client-hello") {
      if (this.role !== "responder" || this.ready) return;
      const clientHello = hello as {
        clientId?: unknown;
        sessionId?: unknown;
        identityPublicKey?: JsonWebKey;
      };
      if (clientHello.clientId !== this.remote.peerId) {
        this.lastError = "client id mismatch";
        this.ctx.onChange();
        return;
      }
      if (clientHello.sessionId !== message.sessionId) return;
      const expected = await publicKeyFingerprint(this.remote.identityPublicKey);
      const received = clientHello.identityPublicKey
        ? await publicKeyFingerprint(clientHello.identityPublicKey)
        : null;
      if (received !== expected) {
        this.lastError = "identity key mismatch";
        this.ctx.onChange();
        return;
      }
      try {
        this.sessionId = message.sessionId;
        this.serverState = await verifyClientHello(hello, {
          tenant: DEMO_TENANT,
          serverId: DEMO_SERVER_ID,
          validateCapability: async () => ({
            clientId: this.remote.peerId,
            subject: this.remote.peerId,
            identityFingerprint: expected,
          }),
        });
        const { hello: serverHello, state } = await createServerHello(
          this.serverState,
          this.ctx.identity,
        );
        await this.publishHandshake(serverHello);
        const derived = await completeServerHandshake(state);
        await this.createReady(derived, "server");
      } catch (error) {
        this.failHandshake(P2PLinkError.from(error).message);
      }
      return;
    }

    if (kind === "server-hello") {
      if (this.role !== "initiator" || !this.clientState) return;
      if (message.sessionId !== this.sessionId) return;
      try {
        const derived = await completeClientHandshake(this.clientState, hello, {
          serverIdentityPin: { publicKeyJwk: this.remote.identityPublicKey },
        });
        await this.createReady(derived, "client");
      } catch (error) {
        this.failHandshake(P2PLinkError.from(error).message);
      }
    }
  }

  private async publishHandshake(hello: unknown): Promise<void> {
    const message: HandshakeMessage = {
      v: 1,
      type: "handshake",
      sessionId: this.sessionId,
      hello,
    };
    await this.ctx.connection.publish(
      signalTopic(this.remote.peerId, this.ctx.self.peerId),
      JSON.stringify(message),
      1,
    );
  }

  private async createReady(derived: DerivedSession, side: "client" | "server"): Promise<void> {
    if (this.closed || this.manager) return;
    this.clearTimer("handshake");
    this.security = new TransportSecurity(derived, side, {
      maxFrameBytes: MAX_FRAME_BYTES,
    });
    this.mqtt = new DemoMqttTransport(
      this.ctx.connection,
      dataTopic(this.remote.peerId, this.ctx.self.peerId),
      dataTopic(this.ctx.self.peerId, this.remote.peerId),
      MAX_FRAME_BYTES,
    );
    const manager = new TransportManager({
      sessionId: derived.sessionId,
      clientId: this.ctx.self.peerId,
      serverId: DEMO_SERVER_ID,
      transports: { mqtt: this.mqtt },
      security: this.security,
      limits: {
        heartbeatIntervalMs: 1_500,
        heartbeatTimeoutMs: 5_000,
        promoteAfterMs: 800,
        switchCooldownMs: 3_000,
        maxPendingPings: 8,
        maxFrameBytes: MAX_FRAME_BYTES,
      },
      logger: this.ctx.logger,
      onUnhealthy: (kind) => {
        if (kind === "webrtc") this.restartWebRtc("unhealthy");
      },
    });
    this.manager = manager;
    this.ctx.logger.debug("pair manager started", { peerId: this.remote.peerId, role: this.role });
    manager.onEnvelope((envelope, transport) => {
      this.ctx.logger.debug("pair envelope", {
        peerId: this.remote.peerId,
        type: envelope.type,
        transport,
      });
      this.handleEnvelope(envelope, transport);
    });
    manager.onStatus((snapshot) => {
      this.route =
        snapshot.transport === "webrtc"
          ? "p2p"
          : snapshot.transport === "mqtt"
            ? "mqtt"
            : "connecting";
      this.ctx.onChange();
    });
    manager.start();
    try {
      await manager.waitForTransport(10_000);
    } catch (error) {
      this.lastError = P2PLinkError.from(error).message;
      this.ctx.logger.warn("pair transport not ready", {
        peerId: this.remote.peerId,
        error: this.lastError,
      });
      this.close("transport not ready");
      return;
    }
    if (this.closed) return;
    this.ready = true;
    this.lastError = null;
    this.ctx.logger.info("pair ready", {
      peerId: this.remote.peerId,
      role: this.role,
      sessionId: derived.sessionId,
    });
    this.ctx.onChange();
    if (this.ctx.webRtcEnabled()) void this.startWebRtc();
  }

  private handleEnvelope(
    envelope: ReturnType<typeof createEnvelope>,
    transport: TransportKind,
  ): void {
    if (this.closed) return;
    if (envelope.type === "signal") {
      const signal = envelope.payload as SignalPayload;
      if (this.webrtc) {
        void this.webrtc.handleSignal(signal);
      } else if (this.pendingSignals.length < 32) {
        this.pendingSignals.push(signal);
      }
      return;
    }
    if (envelope.type === "request") {
      void this.handlePingRequest(envelope, transport);
      return;
    }
    if (envelope.type === "response") {
      void this.handlePingResponse(envelope, transport);
    }
  }

  async sendPing(): Promise<void> {
    if (!this.canPing() || !this.manager) return;
    const bytes = randomBytes(this.ctx.pingBytes);
    const id = randomToken(8);
    const hash = await sha256Base64Url(bytes);
    const payload = {
      method: "demo.ping",
      params: {
        kind: "ping",
        id,
        size: bytes.length,
        bytes: toBase64Url(bytes),
        hash,
      },
    };
    const envelope = createEnvelope("request", this.sessionId, payload);
    const sentAt = Date.now();
    const timer = setTimeout(() => {
      if (this.inFlight?.id !== id) return;
      this.inFlight = null;
      this.lastError = "ping timeout";
      this.ctx.onChange();
    }, this.ctx.pingTimeoutMs);
    timer.unref?.();
    this.inFlight = { id, envelopeId: envelope.id, size: bytes.length, sentAt, timer };
    try {
      const kind = await this.manager.send(envelope);
      this.meter.add(kind, bytes.length);
      this.lastPingAt = sentAt;
      this.ctx.onChange();
    } catch (error) {
      if (this.inFlight?.id === id) {
        clearTimeout(timer);
        this.inFlight = null;
      }
      this.lastError = P2PLinkError.from(error).message;
      this.ctx.onChange();
    }
  }

  private async handlePingRequest(
    envelope: ReturnType<typeof createEnvelope>,
    transport: TransportKind,
  ): Promise<void> {
    const payload = envelope.payload as { method?: unknown; params?: unknown } | null;
    const params = payload?.params as
      { kind?: unknown; id?: unknown; size?: unknown; bytes?: unknown; hash?: unknown } | undefined;
    if (payload?.method !== "demo.ping" || params?.kind !== "ping") return;
    const id = typeof params.id === "string" ? params.id : null;
    const encoded = typeof params.bytes === "string" ? params.bytes : null;
    const expectedHash = typeof params.hash === "string" ? params.hash : null;
    const expectedSize = typeof params.size === "number" ? params.size : -1;
    let bytes: Uint8Array | null = null;
    try {
      bytes = encoded ? fromBase64Url(encoded) : null;
    } catch {
      bytes = null;
    }
    const received = bytes?.length ?? 0;
    if (received > 0) this.meter.add(transport, received);
    if (!bytes || !expectedHash || bytes.length !== expectedSize) {
      this.lastError = "invalid ping payload";
      this.ctx.onChange();
      await this.sendPong(envelope.id, id, null, "invalid");
      return;
    }
    const actualHash = await sha256Base64Url(bytes);
    if (actualHash !== expectedHash) {
      this.lastError = "ping hash mismatch";
      this.ctx.onChange();
      await this.sendPong(envelope.id, id, null, "hash-mismatch");
      return;
    }
    await this.sendPong(envelope.id, id, { bytes, hash: actualHash, size: bytes.length }, null);
  }

  private async sendPong(
    requestId: string,
    pingId: string | null,
    echo: { bytes: Uint8Array; hash: string; size: number } | null,
    error: string | null,
  ): Promise<void> {
    if (!this.manager) return;
    const envelope = createEnvelope(
      "response",
      this.sessionId,
      {
        kind: "pong",
        id: pingId,
        ok: error === null,
        ...(error === null ? {} : { error }),
        ...(echo === null
          ? {}
          : { size: echo.size, bytes: toBase64Url(echo.bytes), hash: echo.hash }),
      },
      { cid: requestId },
    );
    try {
      const kind = await this.manager.send(envelope);
      if (echo) this.meter.add(kind, echo.size);
    } catch (errorValue) {
      this.lastError = P2PLinkError.from(errorValue).message;
      this.ctx.onChange();
    }
  }

  private async handlePingResponse(
    envelope: ReturnType<typeof createEnvelope>,
    transport: TransportKind,
  ): Promise<void> {
    const pending = this.inFlight;
    if (!pending || envelope.cid !== pending.envelopeId) return;
    const payload = envelope.payload as {
      kind?: unknown;
      id?: unknown;
      ok?: unknown;
      error?: unknown;
      bytes?: unknown;
      hash?: unknown;
      size?: unknown;
    } | null;
    if (payload?.kind !== "pong" || payload.id !== pending.id) return;
    clearTimeout(pending.timer);
    this.inFlight = null;
    if (payload.ok !== true) {
      this.lastError = typeof payload.error === "string" ? payload.error : "pong rejected";
      this.ctx.onChange();
      return;
    }
    try {
      const encoded = typeof payload.bytes === "string" ? payload.bytes : "";
      const bytes = fromBase64Url(encoded);
      const hash = typeof payload.hash === "string" ? payload.hash : "";
      const expectedSize = typeof payload.size === "number" ? payload.size : -1;
      if (bytes.length !== expectedSize || bytes.length !== pending.size) {
        throw new Error("response size mismatch");
      }
      if ((await sha256Base64Url(bytes)) !== hash) {
        throw new Error("response hash mismatch");
      }
      this.meter.add(transport, bytes.length);
      this.pings += 1;
      this.rttMs = Math.max(0, Date.now() - pending.sentAt);
      this.lastError = null;
    } catch (error) {
      this.lastError = P2PLinkError.from(error).message;
    }
    this.ctx.onChange();
  }

  private async startWebRtc(): Promise<void> {
    if (this.closed || !this.ready || !this.manager || this.webrtc || !this.ctx.webRtcEnabled()) {
      return;
    }
    const transport = new WebRtcTransport({
      engine: this.ctx.engine,
      role: this.role === "initiator" ? "offerer" : "answerer",
      negotiationId: this.sessionId,
      epoch: 0,
      iceServers: [],
      maxFrameBytes: MAX_FRAME_BYTES,
      logger: this.ctx.logger,
      sendSignal: async (signal) => {
        if (!this.manager) throw new P2PLinkError(P2PLinkErrorCodes.OFFLINE, "pair closed");
        await this.manager.send(createEnvelope("signal", this.sessionId, signal), {
          via: "mqtt",
        });
      },
    });
    this.webrtc = transport;
    this.manager.setTransport("webrtc", transport);
    transport.onStateChange((state) => {
      if (this.webrtc !== transport) return;
      if (state === "failed" || state === "closed") {
        this.webrtc = null;
        this.manager?.setTransport("webrtc", undefined);
        this.scheduleWebRtcRetry();
      }
    });
    for (const signal of this.pendingSignals.splice(0)) {
      void transport.handleSignal(signal);
    }
    if (this.role === "initiator") {
      try {
        await transport.start();
      } catch (error) {
        this.lastError = P2PLinkError.from(error).message;
        if (this.webrtc === transport) {
          this.webrtc = null;
          this.manager.setTransport("webrtc", undefined);
          this.scheduleWebRtcRetry();
        }
      }
    }
  }

  private restartWebRtc(reason: string): void {
    this.lastError = reason;
    const current = this.webrtc;
    this.webrtc = null;
    if (current) void current.close();
    this.manager?.setTransport("webrtc", undefined);
    this.scheduleWebRtcRetry();
  }

  private scheduleWebRtcRetry(): void {
    if (this.closed || !this.ready || !this.ctx.webRtcEnabled() || this.webrtcTimer) return;
    this.webrtcTimer = setTimeout(() => {
      this.webrtcTimer = null;
      void this.startWebRtc();
    }, WEBRTC_RETRY_MS);
    this.webrtcTimer.unref?.();
  }

  setWebRtcEnabled(enabled: boolean): void {
    if (!enabled) {
      this.clearTimer("webrtc");
      const current = this.webrtc;
      this.webrtc = null;
      if (current) void current.close();
      this.manager?.setTransport("webrtc", undefined);
      this.route = "mqtt";
      this.ctx.onChange();
    } else if (this.ready) {
      void this.startWebRtc();
    }
  }

  resetStats(): void {
    this.meter.reset();
    this.pings = 0;
    this.rttMs = null;
    this.lastPingAt = null;
    this.lastError = null;
    this.ctx.onChange();
  }

  snapshot(now = Date.now()): PairView {
    const rate = this.meter.snapshot(now);
    return {
      peerId: this.remote.peerId,
      name: this.remote.name,
      kind: this.remote.kind,
      route: this.route,
      rttMs: this.rttMs,
      p2pBytes: rate.p2pBytes,
      mqttBytes: rate.mqttBytes,
      p2pBytesPerSec: rate.p2pBytesPerSec,
      mqttBytesPerSec: rate.mqttBytesPerSec,
      pings: this.pings,
      lastPingAt: this.lastPingAt,
      lastError: this.lastError,
    };
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.clearTimer("handshake");
    this.clearTimer("retry");
    this.clearTimer("webrtc");
    if (this.inFlight) {
      clearTimeout(this.inFlight.timer);
      this.inFlight = null;
    }
    const webrtc = this.webrtc;
    this.webrtc = null;
    if (webrtc) void webrtc.close(reason);
    this.manager?.stop();
    this.manager = null;
    this.mqtt = null;
    this.security = null;
    this.pendingSignals.length = 0;
    this.ctx.logger.debug("pair closed", { peerId: this.remote.peerId, reason });
    this.ctx.onChange();
  }

  private failHandshake(message: string): void {
    if (this.closed || this.ready) return;
    this.lastError = message;
    this.ctx.onChange();
    this.ctx.logger.warn("pair handshake failed", {
      peerId: this.remote.peerId,
      message,
    });
    this.clearTimer("handshake");
    if (this.role === "initiator" && !this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.closed && !this.ready) this.startHandshake();
      }, HANDSHAKE_RETRY_MS);
      this.retryTimer.unref?.();
    }
  }

  private clearTimer(kind: "handshake" | "retry" | "webrtc"): void {
    if (kind === "handshake" && this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    } else if (kind === "retry" && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    } else if (kind === "webrtc" && this.webrtcTimer) {
      clearTimeout(this.webrtcTimer);
      this.webrtcTimer = null;
    }
  }
}
