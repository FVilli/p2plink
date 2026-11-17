import {
  P2PLinkError,
  P2PLinkErrorCodes,
  TransportManager,
  createEnvelope,
  decodeEnvelopeJson,
  encodeEnvelopeJson,
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
  type SignedServerHello,
} from "@p2plink/crypto";
import type { MqttConnection } from "@p2plink/mqtt";
import { DemoMqttTransport } from "./transport.js";
import type { WebRtcEngine, WebRtcTransport as WebRtcTransportType } from "@p2plink/webrtc";
import { WebRtcTransport } from "@p2plink/webrtc";
import { RateMeter } from "./rate.js";
import { verifyPingPayload } from "./ping.js";
import { ROUTE_MAX_BYTES, type PingRouter } from "./routing.js";
import { DEMO_CAPABILITY, DEMO_SERVER_ID, DEMO_TENANT, dataTopic, signalTopic } from "./topics.js";
import type {
  HandshakeMessage,
  IssueLevel,
  PairView,
  PeerKind,
  PeerRoute,
  RemotePeer,
  TrafficView,
} from "./types.js";

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
  iceServers?: import("@p2plink/core").IceServer[];
  pingConfig: () => import("./types.js").MeshPingConfig;
  pingTimeoutMs: number;
  transportConfirmTimeoutMs?: number;
  logger: Logger;
  webRtcEnabled: () => boolean;
  router: PingRouter;
  onChange: () => void;
  reportIssue: (
    level: IssueLevel,
    message: string,
    context?: Record<string, string | number | boolean>,
  ) => void;
}

interface PendingPing {
  id: string;
  envelopeId: string;
  size: number;
  hash: string;
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
  private lastServerHello: SignedServerHello | null = null;
  private sessionToken = 0;
  private security: TransportSecurity | null = null;
  private manager: TransportManager | null = null;
  private mqtt: import("./transport.js").DemoMqttTransport | null = null;
  private webrtc: WebRtcTransportType | null = null;
  private pendingSignals: SignalPayload[] = [];
  private pendingSignalFrames: Uint8Array[] = [];
  private ready = false;
  private closed = false;
  private readonly inFlight = new Map<string, PendingPing>();
  private helloSending = false;
  private answering: Promise<void> | null = null;
  private pendingClientHello: { sessionId: string; hello: unknown } | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private webrtcTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recovering = false;
  private epoch = 0;
  private route: PeerRoute = "connecting";
  private readonly meter = new RateMeter();
  private pings = 0;
  private roundTrips = 0;
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

  traffic(): TrafficView {
    return this.meter.snapshot().traffic;
  }

  canPing(): boolean {
    return Boolean(
      this.ready &&
      !this.closed &&
      this.manager &&
      this.inFlight.size < this.ctx.pingConfig().concurrency &&
      (this.manager.getSnapshot().transport !== null || this.ctx.router.hasCandidates(this.peerId)),
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
    if (this.closed || this.ready || this.role !== "initiator" || this.helloSending) return;
    this.helloSending = true;
    this.clearTimer("handshake");
    this.clearTimer("retry");
    try {
      if (!this.clientState) {
        this.sessionToken += 1;
        this.sessionId = randomToken(24);
        this.clientState = await createClientHello({
          tenant: DEMO_TENANT,
          serverId: DEMO_SERVER_ID,
          clientId: this.ctx.self.peerId,
          sessionId: this.sessionId,
          capability: DEMO_CAPABILITY,
          identity: this.ctx.identity,
        });
      }
      // Resend the same signed hello on retry. This avoids a responder
      // switching to a newer session than the initiator (session mismatch).
      await this.publishHandshake(this.clientState.hello);
      this.handshakeTimer = setTimeout(() => {
        this.handshakeTimer = null;
        this.failHandshake("handshake timeout");
      }, HANDSHAKE_TIMEOUT_MS);
    } catch (error) {
      this.failHandshake(P2PLinkError.from(error).message);
    } finally {
      this.helloSending = false;
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
      if (this.role !== "responder") return;
      if (this.answering) {
        if (this.sessionId === message.sessionId) {
          await this.answering;
          if (this.sessionId === message.sessionId && this.lastServerHello) {
            await this.publishHandshake(this.lastServerHello);
          }
        } else {
          // Dropping a new session hello here can leave its initiator connecting forever.
          this.pendingClientHello = { sessionId: message.sessionId, hello };
        }
        return;
      }
      this.pendingClientHello = { sessionId: message.sessionId, hello };
      this.answering = this.drainClientHellos();
      try {
        await this.answering;
      } finally {
        this.answering = null;
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
        await this.createReady(derived, "client", this.sessionToken);
      } catch (error) {
        this.failHandshake(P2PLinkError.from(error).message);
      }
    }
  }

  private async drainClientHellos(): Promise<void> {
    while (!this.closed && this.pendingClientHello) {
      const pending = this.pendingClientHello;
      this.pendingClientHello = null;
      await this.answerClientHello(pending.sessionId, pending.hello);
    }
  }

  private async answerClientHello(sessionId: string, hello: unknown): Promise<void> {
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
    if (clientHello.sessionId !== sessionId) return;
    if (this.manager) {
      if (this.sessionId === sessionId) {
        if (this.lastServerHello) await this.publishHandshake(this.lastServerHello);
        return;
      }
      await this.resetSession();
    }
    this.sessionToken += 1;
    const token = this.sessionToken;
    this.lastError = null;
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
      this.sessionId = sessionId;
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
      this.lastServerHello = serverHello;
      await this.publishHandshake(serverHello);
      const derived = await completeServerHandshake(state);
      await this.createReady(derived, "server", token);
    } catch (error) {
      this.failHandshake(P2PLinkError.from(error).message);
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

  private async createReady(
    derived: DerivedSession,
    side: "client" | "server",
    token: number,
  ): Promise<void> {
    if (this.closed || this.manager || token !== this.sessionToken) return;
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
        heartbeatIntervalMs: 2_000,
        heartbeatTimeoutMs: 6_000,
        promoteAfterMs: 800,
        switchCooldownMs: 3_000,
        maxPendingPings: 8,
        maxFrameBytes: MAX_FRAME_BYTES,
      },
      idleMqttProbeIntervalMs: 0,
      assumeMqttReachableOnOpen: true,
      logger: this.ctx.logger,
      onUnhealthy: (kind) => {
        if (kind === "webrtc") this.restartWebRtc("unhealthy");
      },
    });
    this.manager = manager;
    manager.onEnvelope((envelope, transport) => {
      this.handleEnvelope(envelope, transport);
    });
    manager.onStatus((snapshot) => {
      this.route =
        snapshot.transport === "webrtc"
          ? "p2p"
          : snapshot.transport === "mqtt"
            ? "mqtt"
            : "connecting";
      if (snapshot.transport === null && this.ready && this.role === "initiator") {
        this.scheduleRecovery();
      } else if (snapshot.transport !== null) {
        this.clearTimer("recovery");
      }
      this.ctx.onChange();
    });
    manager.start();
    try {
      await manager.waitForConfirmedTransport(this.ctx.transportConfirmTimeoutMs ?? 10_000, "mqtt");
    } catch (error) {
      // A stale confirmation failure must not tear down a newer session.
      if (this.closed || this.sessionToken !== token || this.manager !== manager) {
        this.ctx.logger.debug("stale transport confirmation ignored", {
          peerId: this.remote.peerId,
        });
        return;
      }
      this.lastError = P2PLinkError.from(error).message;
      this.ctx.logger.warn("pair transport not ready", {
        peerId: this.remote.peerId,
        error: this.lastError,
      });
      this.ctx.reportIssue("warn", "pair transport not ready", {
        peerId: this.remote.peerId,
        error: this.lastError,
      });
      await this.resetSession();
      if (this.role === "initiator") this.scheduleRecovery();
      return;
    }
    // Prevent a replaced session from becoming ready. Today this is defensive: resetSession stops
    // the manager and rejects pending confirmations, and manager cannot be replaced without reset.
    // Keep this and the stale-failure check below if resetSession or waitForConfirmedTransport changes.
    if (this.closed || this.sessionToken !== token || this.manager !== manager) return;
    this.ready = true;
    this.lastError = null;
    this.ctx.logger.info("pair ready", {
      peerId: this.remote.peerId,
      role: this.role,
      sessionId: derived.sessionId,
    });
    this.ctx.onChange();
    if (this.ctx.webRtcEnabled()) void this.startWebRtc();
    for (const frame of this.pendingSignalFrames.splice(0)) {
      void this.handleSignalFrame(frame);
    }
  }

  /** Encrypted offer/answer/ICE frames travel on the signal topic, never data. */
  private async publishEncryptedSignal(signal: SignalPayload): Promise<void> {
    if (!this.security) {
      throw new P2PLinkError(P2PLinkErrorCodes.TRANSPORT_UNAVAILABLE, "pair security is not ready");
    }
    const envelope = createEnvelope("signal", this.sessionId, signal);
    const plaintext = encodeEnvelopeJson(envelope, MAX_FRAME_BYTES);
    const frame = await this.security.sealSignal(plaintext);
    await this.ctx.connection.publish(
      signalTopic(this.remote.peerId, this.ctx.self.peerId),
      frame,
      1,
    );
  }

  /** Handles a binary encrypted signal frame from the MQTT signal topic. */
  async handleSignalFrame(frame: Uint8Array): Promise<void> {
    if (this.closed) return;
    if (!this.security) {
      if (this.pendingSignalFrames.length < 32) this.pendingSignalFrames.push(frame);
      return;
    }
    try {
      const plaintext = await this.security.openSignal(frame);
      const envelope = decodeEnvelopeJson(plaintext, MAX_FRAME_BYTES);
      if (envelope.sid !== this.sessionId || envelope.type !== "signal") return;
      this.handleEnvelope(envelope, "mqtt");
    } catch (error) {
      this.lastError = P2PLinkError.from(error).message;
      this.ctx.logger.warn("encrypted signaling rejected", {
        peerId: this.remote.peerId,
        error: this.lastError,
      });
      this.ctx.reportIssue("warn", "encrypted signaling rejected", {
        peerId: this.remote.peerId,
        error: this.lastError,
      });
      this.ctx.onChange();
    }
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
    if (envelope.type === "event") {
      if (transport === "webrtc") {
        void this.ctx.router.receive(this.peerId, envelope.payload).catch((error: unknown) => {
          this.ctx.logger.debug("ping route rejected", { error: P2PLinkError.from(error).message });
        });
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
    const manager = this.manager;
    const config = this.ctx.pingConfig();
    const bytes = randomBytes(config.bytes);
    const id = randomToken(8);
    const envelope = createEnvelope("request", this.sessionId, {
      method: "demo.ping",
      params: { kind: "ping", id, size: bytes.length, bytes: toBase64Url(bytes), hash: "" },
    });
    const sentAt = Date.now();
    const timer = setTimeout(() => {
      this.releasePing(id);
      this.lastError = "OUTCOME_UNKNOWN: ping timeout";
      this.ctx.onChange();
    }, this.ctx.pingTimeoutMs);
    timer.unref?.();
    this.inFlight.set(id, {
      id,
      envelopeId: envelope.id,
      size: bytes.length,
      hash: "",
      sentAt,
      timer,
    });
    let relay: string | null = null;
    try {
      relay = this.isDirectP2P() ? null : await this.ctx.router.findRelay(this.peerId);
      if (this.closed || this.manager !== manager) {
        this.releasePing(id);
        return;
      }
      const hash = await sha256Base64Url(bytes);
      const payload = {
        method: "demo.ping",
        params: { kind: "ping", id, size: bytes.length, bytes: toBase64Url(bytes), hash },
      };
      const request = createEnvelope("request", this.sessionId, payload);
      const pending = this.inFlight.get(id);
      if (!pending) return;
      pending.envelopeId = request.id;
      pending.hash = hash;
      if (relay) {
        this.meter.addTx("webrtc", bytes.length);
        this.pings += 1;
        this.lastPingAt = sentAt;
        const pong = await this.ctx.router.ping(this, relay, request, this.ctx.pingTimeoutMs);
        await this.handlePingResponse(pong, "webrtc");
      } else {
        const via = this.isDirectP2P() ? "webrtc" : "mqtt";
        const kind = await manager.send(request, { via });
        this.meter.addTx(kind, bytes.length);
        this.pings += 1;
        this.lastPingAt = sentAt;
      }
      this.ctx.onChange();
    } catch (error) {
      this.releasePing(id);
      this.lastError = P2PLinkError.from(error).message;
      if (!relay)
        this.ctx.reportIssue("warn", "ping send failed", {
          peerId: this.remote.peerId,
          error: this.lastError,
        });
      this.ctx.onChange();
    }
  }

  private releasePing(id: string): void {
    const pending = this.inFlight.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.inFlight.delete(id);
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
      if (encoded) bytes = fromBase64Url(encoded);
    } catch {
      bytes = null;
    }
    const received = bytes?.length ?? 0;
    this.meter.addRx(transport, received);
    const verified = await verifyPingPayload({
      size: expectedSize,
      bytes: encoded ?? "",
      hash: expectedHash ?? "",
    });
    if (!verified) {
      this.lastError = "ping integrity failure";
      this.ctx.onChange();
      await this.sendPong(envelope.id, id, null, "integrity");
      return;
    }
    const actualHash = await sha256Base64Url(verified);
    await this.sendPong(
      envelope.id,
      id,
      { bytes: verified, hash: actualHash, size: verified.length },
      null,
    );
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
      this.meter.addTx(kind, echo?.size ?? 0);
    } catch (errorValue) {
      this.lastError = P2PLinkError.from(errorValue).message;
      this.ctx.onChange();
    }
  }

  private async handlePingResponse(
    envelope: ReturnType<typeof createEnvelope>,
    transport: TransportKind,
  ): Promise<void> {
    const pending = [...this.inFlight.values()].find((item) => envelope.cid === item.envelopeId);
    if (!pending) return;
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
    this.releasePing(pending.id);
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
      if (hash !== pending.hash || (await sha256Base64Url(bytes)) !== hash) {
        throw new Error("response hash mismatch");
      }
      this.meter.addRx(transport, bytes.length);
      this.roundTrips += 1;
      this.rttMs = Math.max(0, Date.now() - pending.sentAt);
      this.lastError = null;
    } catch (error) {
      this.lastError = P2PLinkError.from(error).message;
    }
    this.ctx.onChange();
  }

  isDirectP2P(): boolean {
    return this.isReady && this.manager?.getSnapshot().transport === "webrtc";
  }

  async sendRouteEvent(payload: unknown): Promise<void> {
    if (!this.isDirectP2P() || !this.manager) throw new Error("route hop unavailable");
    await this.manager.send(createEnvelope("event", this.sessionId, payload), { via: "webrtc" });
  }

  async sealRoutedPing(envelope: ReturnType<typeof createEnvelope>): Promise<string> {
    if (!this.isReady || !this.security || envelope.sid !== this.sessionId)
      throw new Error("route session unavailable");
    const frame = await this.security.seal(
      "mqtt",
      encodeEnvelopeJson(envelope, ROUTE_MAX_BYTES - 38),
    );
    return toBase64Url(frame);
  }

  async openRoutedPing(frame: string): Promise<ReturnType<typeof createEnvelope>> {
    if (!this.isReady || !this.security || frame.length > Math.ceil((ROUTE_MAX_BYTES * 4) / 3))
      throw new Error("invalid route frame");
    const bytes = fromBase64Url(frame);
    if (bytes.length > ROUTE_MAX_BYTES) throw new Error("route frame too large");
    const envelope = decodeEnvelopeJson(await this.security.open("mqtt", bytes), ROUTE_MAX_BYTES);
    if (envelope.sid !== this.sessionId) throw new Error("route session mismatch");
    return envelope;
  }

  async answerRoutedPing(
    envelope: ReturnType<typeof createEnvelope>,
  ): Promise<ReturnType<typeof createEnvelope>> {
    const payload = envelope.payload as {
      method?: unknown;
      params?: { kind?: unknown; id?: unknown; size?: unknown; bytes?: unknown; hash?: unknown };
    };
    const params = payload.params;
    if (
      payload.method !== "demo.ping" ||
      params?.kind !== "ping" ||
      typeof params.id !== "string" ||
      typeof params.size !== "number" ||
      params.size < 1 ||
      params.size > 60_000
    )
      throw new Error("invalid routed ping");
    const bytes = await verifyPingPayload(params);
    if (!bytes) throw new Error("routed ping integrity failure");
    this.meter.addRx("webrtc", bytes.length);
    this.meter.addTx("webrtc", bytes.length);
    return createEnvelope(
      "response",
      this.sessionId,
      {
        kind: "pong",
        id: params.id,
        ok: true,
        size: bytes.length,
        bytes: params.bytes,
        hash: params.hash,
      },
      { cid: envelope.id },
    );
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
      iceServers: this.ctx.iceServers ?? [],
      maxFrameBytes: MAX_FRAME_BYTES,
      logger: this.ctx.logger,
      sendSignal: async (signal) => {
        await this.publishEncryptedSignal(signal);
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
        this.ctx.reportIssue("warn", "webrtc start failed", {
          peerId: this.remote.peerId,
          error: this.lastError,
        });
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
    this.ctx.reportIssue("warn", "webrtc restart", {
      peerId: this.remote.peerId,
      reason,
    });
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
      this.manager?.probeNow();
      this.route = "mqtt";
      this.ctx.onChange();
    } else if (this.ready) {
      void this.startWebRtc();
    }
  }

  resetStats(): void {
    this.meter.reset();
    this.pings = 0;
    this.roundTrips = 0;
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
      version: this.remote.version,
      route: this.route,
      rttMs: this.rttMs,
      p2pBytes: rate.p2pBytes,
      mqttBytes: rate.mqttBytes,
      p2pMessages: rate.p2pMessages,
      mqttMessages: rate.mqttMessages,
      p2pBytesPerSec: rate.p2pBytesPerSec,
      mqttBytesPerSec: rate.mqttBytesPerSec,
      traffic: rate.traffic,
      remoteTraffic: this.remote.traffic,
      pings: this.pings,
      roundTrips: this.roundTrips,
      lastPingAt: this.lastPingAt,
      lastError: this.lastError,
    };
  }

  private async resetSession(): Promise<void> {
    // A transport failure for the active hello must not discard a newer hello queued meanwhile.
    this.clearTimer("recovery");
    this.ready = false;
    this.lastServerHello = null;
    this.clientState = null;
    this.serverState = null;
    this.pendingSignals.length = 0;
    this.pendingSignalFrames.length = 0;
    for (const pending of this.inFlight.values()) clearTimeout(pending.timer);
    this.inFlight.clear();
    const webrtc = this.webrtc;
    this.webrtc = null;
    if (webrtc) await webrtc.close("session-replaced");
    this.manager?.stop();
    this.manager = null;
    this.mqtt = null;
    this.security = null;
    this.route = "connecting";
    this.ctx.onChange();
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingClientHello = null;
    this.ready = false;
    this.clearTimer("handshake");
    this.clearTimer("retry");
    this.clearTimer("webrtc");
    this.clearTimer("recovery");
    for (const pending of this.inFlight.values()) clearTimeout(pending.timer);
    this.inFlight.clear();
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

  private scheduleRecovery(): void {
    if (this.closed || this.recoveryTimer || this.recovering) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.recoverSession();
    }, HANDSHAKE_RETRY_MS);
    this.recoveryTimer.unref?.();
  }

  private async recoverSession(): Promise<void> {
    if (this.closed || this.role !== "initiator" || this.recovering) return;
    this.recovering = true;
    try {
      await this.resetSession();
      if (!this.closed) this.startHandshake();
    } finally {
      this.recovering = false;
    }
  }

  private failHandshake(message: string): void {
    if (this.closed || this.ready) return;
    this.lastError = message;
    this.ctx.reportIssue("warn", "pair handshake failed", {
      peerId: this.remote.peerId,
      error: message,
    });
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

  private clearTimer(kind: "handshake" | "retry" | "webrtc" | "recovery"): void {
    if (kind === "handshake" && this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    } else if (kind === "retry" && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    } else if (kind === "webrtc" && this.webrtcTimer) {
      clearTimeout(this.webrtcTimer);
      this.webrtcTimer = null;
    } else if (kind === "recovery" && this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }
}
