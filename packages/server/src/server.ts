import {
  DEFAULT_LIMITS,
  MemoryIdempotencyStore,
  P2PLinkError,
  P2PLinkErrorCodes,
  RpcServer,
  TokenBucket,
  TransportManager,
  canonicalJson,
  createEnvelope,
  noopLogger,
  toBase64Url,
  utf8Encode,
  type IceServer,
  type IdempotencyStore,
  type Logger,
  type P2PLinkLimits,
  type RpcAuthorizer,
  type RpcHandler,
  type RpcHandlerOptions,
  type RpcIdentity,
  type ServerIdentity,
  type SignalPayload,
  type SignalReset,
  type TransportKind,
  type Unsubscribe,
} from "@p2plink/core";
import {
  TransportSecurity,
  completeServerHandshake,
  createServerHello,
  verifyClientHello,
} from "@p2plink/crypto";
import {
  MqttConnection,
  MqttServerEndpoint,
  MqttTransport,
  type MqttServerClientEndpoint,
} from "@p2plink/mqtt";
import { WebRtcTransport, type WebRtcEngine } from "@p2plink/webrtc";
import {
  BootstrapService,
  type BootstrapHttpRequest,
  type BootstrapHttpResponse,
  type BootstrapOptions,
} from "./bootstrap.js";
import { verifyCapability } from "./capability.js";

export interface ServerMqttConfig {
  url: string;
  username?: string;
  password?: string;
  clientId?: string;
  keepaliveSeconds?: number;
  reconnectPeriodMs?: number;
  connectTimeoutMs?: number;
}

export interface ServerWebRtcConfig {
  enabled?: boolean;
  iceServers?: IceServer[];
  /** Required when WebRTC is enabled. */
  engine?: WebRtcEngine;
}

export interface P2PLinkServerConfig {
  serverId: string;
  tenant?: string;
  identity: ServerIdentity;
  bootstrap: BootstrapOptions;
  mqtt: ServerMqttConfig;
  webrtc?: ServerWebRtcConfig;
  limits?: Partial<P2PLinkLimits>;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlMs?: number;
  authorize?: RpcAuthorizer;
  clockSkewMs?: number;
  logger?: Logger;
}

export interface SessionInfo {
  clientId: string;
  sessionId: string;
  subject: string;
  transport: TransportKind | null;
  rttMs: number | null;
  pendingRequests: number;
  connectedAt: number | null;
}

interface ServerSession {
  clientId: string;
  sessionId: string;
  identity: RpcIdentity;
  endpoint: MqttServerClientEndpoint;
  manager: TransportManager;
  security: TransportSecurity;
  bucket: TokenBucket;
  pendingRequests: number;
  lastHealthyAt: number;
  webrtc: WebRtcTransport | null;
  signalChain: Promise<void>;
  closed: boolean;
}

export class P2PLinkServer {
  private readonly config: P2PLinkServerConfig & {
    tenant: string;
    limits: P2PLinkLimits;
    clockSkewMs: number;
  };
  private readonly logger: Logger;
  private readonly limits: P2PLinkLimits;
  private readonly rpc: RpcServer;
  private readonly bootstrapService: BootstrapService;
  private readonly sessions = new Map<string, ServerSession>();
  private readonly handshakeQueues = new Map<string, Promise<void>>();
  private readonly handshakeBuckets = new Map<string, TokenBucket>();
  private mqtt: MqttConnection | null = null;
  private endpoint: MqttServerEndpoint | null = null;
  private handshakeUnsubscribe: Unsubscribe | null = null;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private activeHandshakes = 0;
  private started = false;

  constructor(config: P2PLinkServerConfig) {
    if (!config.serverId) {
      throw new P2PLinkError(P2PLinkErrorCodes.INVALID_CONFIG, "serverId is required");
    }
    if (!config.identity?.sign || !config.identity.publicKeyJwk) {
      throw new P2PLinkError(P2PLinkErrorCodes.INVALID_CONFIG, "Server identity is required");
    }
    this.config = {
      ...config,
      tenant: config.tenant ?? "default",
      limits: { ...DEFAULT_LIMITS, ...config.limits },
      clockSkewMs: config.clockSkewMs ?? 120_000,
    };
    this.logger = config.logger ?? noopLogger;
    this.limits = this.config.limits;
    this.rpc = new RpcServer({
      idempotency: config.idempotencyStore ?? new MemoryIdempotencyStore(),
      defaultTimeoutMs: this.limits.requestTimeoutMs,
      maxPayloadBytes: this.limits.maxPayloadBytes,
      ...(config.idempotencyTtlMs === undefined
        ? {}
        : { idempotencyTtlMs: config.idempotencyTtlMs }),
      ...(config.authorize === undefined ? {} : { authorize: config.authorize }),
      logger: this.logger,
    });
    this.bootstrapService = new BootstrapService(
      {
        serverId: this.config.serverId,
        tenant: this.config.tenant,
        identity: this.config.identity,
      },
      config.bootstrap,
    );
    if (this.config.webrtc?.enabled && !this.config.webrtc.engine) {
      throw new P2PLinkError(
        P2PLinkErrorCodes.INVALID_CONFIG,
        "A WebRTC engine is required when WebRTC is enabled",
      );
    }
  }

  get publicIdentity(): { identityId: string; publicKeyJwk: JsonWebKey } {
    return {
      identityId: this.config.identity.identityId,
      publicKeyJwk: this.config.identity.publicKeyJwk,
    };
  }

  register(request: string, handler: RpcHandler, options: RpcHandlerOptions = {}): this {
    this.rpc.register(request, handler, options);
    return this;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const mqtt = new MqttConnection({
      url: this.config.mqtt.url,
      clientId: this.config.mqtt.clientId ?? `p2p-server-${this.config.serverId}`,
      ...(this.config.mqtt.username === undefined ? {} : { username: this.config.mqtt.username }),
      ...(this.config.mqtt.password === undefined ? {} : { password: this.config.mqtt.password }),
      ...(this.config.mqtt.keepaliveSeconds === undefined
        ? {}
        : { keepaliveSeconds: this.config.mqtt.keepaliveSeconds }),
      ...(this.config.mqtt.reconnectPeriodMs === undefined
        ? {}
        : { reconnectPeriodMs: this.config.mqtt.reconnectPeriodMs }),
      ...(this.config.mqtt.connectTimeoutMs === undefined
        ? {}
        : { connectTimeoutMs: this.config.mqtt.connectTimeoutMs }),
      maxPayloadBytes: this.limits.maxFrameBytes,
      logger: this.logger,
    });
    this.mqtt = mqtt;
    await mqtt.connect();
    const endpoint = new MqttServerEndpoint(mqtt, {
      tenant: this.config.tenant,
      serverId: this.config.serverId,
      maxFrameBytes: this.limits.maxFrameBytes,
      logger: this.logger,
      onUnknownClient: (clientId) => {
        void this.resetClient(clientId, "unknown-session");
      },
    });
    this.endpoint = endpoint;
    await endpoint.start();
    this.handshakeUnsubscribe = endpoint.onHandshake((clientId, message) => {
      this.handleHandshake(clientId, message);
    });
    this.started = true;
    this.gcTimer = setInterval(() => {
      void this.collectIdleSessions();
    }, 5_000);
    this.gcTimer.unref?.();
    this.logger.info("p2plink server started", {
      serverId: this.config.serverId,
      tenant: this.config.tenant,
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.gcTimer = null;
    this.handshakeUnsubscribe?.();
    this.handshakeUnsubscribe = null;
    await Promise.all(
      [...this.sessions.keys()].map((clientId) => this.closeSession(clientId, "server-stop")),
    );
    await this.endpoint?.close();
    this.endpoint = null;
    await this.mqtt?.close();
    this.mqtt = null;
    this.logger.info("p2plink server stopped");
  }

  async handleBootstrap(request: BootstrapHttpRequest): Promise<BootstrapHttpResponse> {
    return this.bootstrapService.handle(request);
  }

  async emitTo(clientId: string, event: string, payload: unknown): Promise<boolean> {
    const session = this.sessions.get(clientId);
    if (!session || session.closed) return false;
    try {
      await session.manager.send(
        createEnvelope("event", session.sessionId, { event, data: payload ?? null }),
      );
      return true;
    } catch (error) {
      this.logger.debug("event delivery failed", {
        clientId,
        event,
        error: P2PLinkError.from(error).message,
      });
      return false;
    }
  }

  /**
   * Operational/test hook: drops only the WebRTC transport of a session.
   * The client should fall back to MQTT and renegotiate P2P automatically.
   */
  async dropP2P(clientId: string): Promise<boolean> {
    const session = this.sessions.get(clientId);
    if (!session) return false;
    const transport = session.webrtc;
    session.webrtc = null;
    session.manager.setTransport("webrtc", undefined);
    if (transport) await transport.close("admin-drop");
    return true;
  }

  getSessionInfo(): SessionInfo[] {
    return [...this.sessions.values()].map((session) => {
      const snapshot = session.manager.getSnapshot();
      return {
        clientId: session.clientId,
        sessionId: session.sessionId,
        subject: session.identity.subject,
        transport: snapshot.transport,
        rttMs: snapshot.rttMs,
        pendingRequests: session.pendingRequests,
        connectedAt: snapshot.connectedAt,
      };
    });
  }

  private handleHandshake(clientId: string, message: unknown): void {
    const previous = this.handshakeQueues.get(clientId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.processHandshake(clientId, message))
      .catch((error: unknown) => {
        this.logger.error("handshake processing failed", {
          clientId,
          error: P2PLinkError.from(error).message,
        });
      });
    this.handshakeQueues.set(clientId, next);
    void next.then(() => {
      if (this.handshakeQueues.get(clientId) === next) this.handshakeQueues.delete(clientId);
    });
  }

  private async processHandshake(clientId: string, message: unknown): Promise<void> {
    if (!this.started || !this.endpoint) return;
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { kind?: unknown }).kind !== "client-hello"
    ) {
      return;
    }
    if ((message as { clientId?: unknown }).clientId !== clientId) {
      await this.resetClient(clientId, "client-id-mismatch");
      return;
    }
    if (this.sessions.size >= this.limits.maxSessions && !this.sessions.has(clientId)) {
      await this.resetClient(clientId, "server-busy");
      return;
    }
    if (this.activeHandshakes >= this.limits.maxHandshakes) {
      this.logger.warn("handshake capacity exceeded", { clientId });
      return;
    }
    if (!this.allowHandshake(clientId)) {
      await this.resetClient(clientId, "handshake-rate-limited");
      return;
    }
    this.activeHandshakes += 1;
    try {
      const state = await verifyClientHello(message, {
        tenant: this.config.tenant,
        serverId: this.config.serverId,
        clockSkewMs: this.config.clockSkewMs,
        validateCapability: async (capability, hello) => {
          const claims = await verifyCapability(
            capability,
            {
              publicKeyJwk: this.config.identity.publicKeyJwk,
              tenant: this.config.tenant,
              serverId: this.config.serverId,
            },
            { clockSkewMs: this.config.clockSkewMs },
          );
          if (claims.clientId !== hello.clientId) {
            throw new P2PLinkError(
              P2PLinkErrorCodes.CAPABILITY_INVALID,
              "Capability client mismatch",
            );
          }
          const consumed = await this.bootstrapService.capabilityStore.consume(
            claims.nonce,
            claims.exp,
          );
          if (!consumed) {
            throw new P2PLinkError(
              P2PLinkErrorCodes.CAPABILITY_USED,
              "Capability has already been used",
            );
          }
          return {
            clientId: claims.clientId,
            subject: claims.sub,
            identityFingerprint: claims.identityFingerprint,
            expiresAt: claims.exp,
            ...(claims.claims === undefined ? {} : { claims: claims.claims }),
          };
        },
      });
      const { hello: serverHello, state: serverState } = await createServerHello(
        state,
        this.config.identity,
      );
      const derived = await completeServerHandshake(serverState);
      // Serialized per client: close the previous session before installing
      // the new registration, so only one endpoint owns the client namespace.
      const previous = this.sessions.get(clientId);
      if (previous) await this.closeSession(clientId, "replaced");
      const endpoint = this.endpoint.forClient(clientId);
      const security = new TransportSecurity(derived, "server", {
        maxFrameBytes: this.limits.maxFrameBytes,
      });
      const mqttTransport = new MqttTransport(endpoint, {
        maxFrameBytes: this.limits.maxFrameBytes,
      });
      const sessionId = state.clientHello.sessionId;
      const identity: RpcIdentity = {
        subject: state.capability.subject ?? clientId,
        identityId: state.clientHello.identityId,
        publicKeyJwk: state.clientHello.identityPublicKey,
        ...(state.capability.claims === undefined ? {} : { claims: state.capability.claims }),
      };
      const manager = new TransportManager({
        sessionId,
        clientId,
        serverId: this.config.serverId,
        transports: { mqtt: mqttTransport },
        security,
        limits: this.limits,
        logger: this.logger,
        onTransportChange: (from, to) => {
          this.logger.debug("client transport changed", { clientId, from, to });
        },
        onUnhealthy: (kind) => {
          if (kind === "webrtc") void this.dropP2P(clientId);
        },
      });
      const session: ServerSession = {
        clientId,
        sessionId,
        identity,
        endpoint,
        manager,
        security,
        bucket: new TokenBucket({
          capacity: this.limits.rateLimitPerSecond * 2,
          refillPerSecond: this.limits.rateLimitPerSecond,
        }),
        pendingRequests: 0,
        lastHealthyAt: Date.now(),
        webrtc: null,
        signalChain: Promise.resolve(),
        closed: false,
      };
      manager.onStatus((snapshot) => {
        if (snapshot.transport) session.lastHealthyAt = Date.now();
      });
      manager.onEnvelope((envelope, transport) => {
        this.handleEnvelope(session, envelope, transport);
      });
      this.sessions.set(clientId, session);
      manager.start();
      await endpoint.sendHandshake(serverHello);
      this.logger.info("client session established", {
        clientId,
        sessionId,
        subject: identity.subject,
      });
    } catch (error) {
      const normalized = P2PLinkError.from(error);
      this.logger.warn("handshake rejected", {
        clientId,
        code: normalized.code,
        message: normalized.message,
      });
      await this.resetClient(clientId, "handshake-rejected");
    } finally {
      this.activeHandshakes -= 1;
    }
  }

  private handleEnvelope(
    session: ServerSession,
    envelope: ReturnType<typeof createEnvelope>,
    transport: TransportKind,
  ): void {
    if (session.closed) return;
    session.lastHealthyAt = Date.now();
    switch (envelope.type) {
      case "close":
        void this.closeSession(session.clientId, "client-close");
        return;
      case "signal": {
        const signal = envelope.payload as SignalPayload;
        session.signalChain = session.signalChain
          .then(() => this.handleSignal(session, signal))
          .catch((error: unknown) => {
            this.logger.warn("signaling queue failed", {
              clientId: session.clientId,
              error: P2PLinkError.from(error).message,
            });
          });
        return;
      }
      case "request":
        void this.handleRequest(session, envelope, transport);
        return;
      default:
        return;
    }
  }

  private async handleRequest(
    session: ServerSession,
    envelope: ReturnType<typeof createEnvelope>,
    transport: TransportKind,
  ): Promise<void> {
    if (!session.bucket.tryRemove()) {
      await this.sendError(
        session,
        envelope,
        P2PLinkErrorCodes.RATE_LIMITED,
        "Rate limit exceeded",
      );
      return;
    }
    if (session.pendingRequests >= this.limits.maxPendingRequests) {
      await this.sendError(
        session,
        envelope,
        P2PLinkErrorCodes.RATE_LIMITED,
        "Too many pending requests",
      );
      return;
    }
    session.pendingRequests += 1;
    session.manager.setPendingRequests(session.pendingRequests);
    try {
      const response = await this.rpc.handle(envelope, {
        identity: session.identity,
        clientId: session.clientId,
        sessionId: session.sessionId,
        serverId: this.config.serverId,
        transport,
      });
      if (response) await session.manager.send(response);
    } catch (error) {
      this.logger.error("rpc handling failed", {
        clientId: session.clientId,
        error: P2PLinkError.from(error).message,
      });
    } finally {
      session.pendingRequests -= 1;
      session.manager.setPendingRequests(session.pendingRequests);
    }
  }

  private async sendError(
    session: ServerSession,
    request: ReturnType<typeof createEnvelope>,
    code: string,
    message: string,
  ): Promise<void> {
    try {
      await session.manager.send(
        createEnvelope(
          "error",
          session.sessionId,
          { code, message, retryable: true, outcomeUnknown: false },
          { cid: request.id },
        ),
      );
    } catch {
      // The session is likely already gone.
    }
  }

  private async handleSignal(session: ServerSession, signal: SignalPayload): Promise<void> {
    if (session.closed || !this.config.webrtc?.enabled) return;
    const engine = this.config.webrtc.engine;
    if (!engine) return;
    let transport: WebRtcTransport | null = null;
    try {
      if (signal.kind === "offer") {
        const existing = session.webrtc;
        session.webrtc = null;
        if (existing) await existing.close("renegotiated");
        session.manager.setTransport("webrtc", undefined);
        transport = new WebRtcTransport({
          engine,
          role: "answerer",
          negotiationId: signal.negotiationId,
          epoch: signal.epoch,
          iceServers: this.config.webrtc.iceServers ?? [],
          maxFrameBytes: this.limits.maxFrameBytes,
          sendSignal: async (payload) => {
            await session.manager.send(createEnvelope("signal", session.sessionId, payload), {
              via: "mqtt",
            });
          },
          logger: this.logger,
        });
        session.webrtc = transport;
        session.manager.setTransport("webrtc", transport);
        transport.onStateChange((state) => {
          if (session.webrtc !== transport) return;
          if (state === "failed" || state === "closed") {
            session.webrtc = null;
            session.manager.setTransport("webrtc", undefined);
          }
        });
        await transport.handleSignal(signal);
      } else if (signal.kind === "ice" || signal.kind === "bye") {
        const current = session.webrtc;
        if (current) {
          transport = current;
          await current.handleSignal(signal);
        }
      }
    } catch (error) {
      this.logger.warn("webrtc signaling failed", {
        clientId: session.clientId,
        error: P2PLinkError.from(error).message,
      });
      if (transport && session.webrtc === transport) {
        session.manager.setTransport("webrtc", undefined);
        session.webrtc = null;
      }
    }
  }

  private async closeSession(clientId: string, reason: string): Promise<void> {
    const session = this.sessions.get(clientId);
    if (!session || session.closed) return;
    session.closed = true;
    this.sessions.delete(clientId);
    this.logger.info("closing client session", { clientId, reason });
    const webrtc = session.webrtc;
    session.webrtc = null;
    if (webrtc) await webrtc.close(reason).catch(() => undefined);
    session.manager.stop();
    await session.endpoint.close().catch(() => undefined);
    session.security.destroy();
  }

  private async collectIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const [clientId, session] of this.sessions) {
      if (now - session.lastHealthyAt > this.limits.sessionIdleTimeoutMs) {
        await this.closeSession(clientId, "idle-timeout");
      }
    }
  }

  private async resetClient(clientId: string, reason: string, sessionId?: string): Promise<void> {
    try {
      const issuedAt = Date.now();
      const payload: Omit<SignalReset, "signature"> = {
        v: 1,
        kind: "session-reset",
        clientId,
        reason,
        issuedAt,
        ...(sessionId === undefined ? {} : { sessionId }),
      };
      const signature = await this.config.identity.sign(
        utf8Encode(`p2plink/v1/control/session-reset\n${canonicalJson(payload)}`),
      );
      await this.endpoint?.publishSessionReset(clientId, {
        ...payload,
        signature: toBase64Url(signature),
      });
    } catch {
      // Best effort.
    }
  }

  private allowHandshake(clientId: string): boolean {
    let bucket = this.handshakeBuckets.get(clientId);
    if (!bucket) {
      bucket = new TokenBucket({ capacity: 5, refillPerSecond: 0.5 });
      this.handshakeBuckets.set(clientId, bucket);
      if (this.handshakeBuckets.size > 10_000) this.handshakeBuckets.clear();
    }
    return bucket.tryRemove();
  }
}
