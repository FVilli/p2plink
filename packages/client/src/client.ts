import {
  DEFAULT_LIMITS,
  P2PLinkError,
  P2PLinkErrorCodes,
  TransportManager,
  createEnvelope,
  noopLogger,
  randomId,
  randomToken,
  type BootstrapResult,
  type ClientIdentity,
  type ConnectionSnapshot,
  type EventContract,
  type P2PLinkLimits,
  type RequestOptions,
  type RpcContract,
  type SignalPayload,
  type Unsubscribe,
  RpcClient,
  sessionTopics,
} from "@p2plink/core";
import {
  TransportSecurity,
  assertServerIdentity,
  completeClientHandshake,
  createClientHello,
  generateIdentity,
  validatePublicJwk,
} from "@p2plink/crypto";
import { MqttConnection, MqttSessionEndpoint, MqttTransport } from "@p2plink/mqtt";
import {
  WebRtcTransport,
  createBrowserWebRtcEngine,
  type WebRtcEngine,
} from "@p2plink/webrtc";
import type { P2PLinkClientConfig } from "./config.js";
import { validateBootstrapResult } from "./bootstrap.js";

export interface P2PLinkClient<C extends RpcContract, E extends EventContract> {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  request<K extends keyof C & string>(
    method: K,
    ...args: C[K]["request"] extends void | undefined
      ? [request?: C[K]["request"], options?: RequestOptions]
      : [request: C[K]["request"], options?: RequestOptions]
  ): Promise<C[K]["response"]>;
  on<K extends keyof E & string>(event: K, listener: (payload: E[K]) => void): Unsubscribe;
  getStatus(): ConnectionSnapshot;
  onStatus(listener: (snapshot: ConnectionSnapshot) => void): Unsubscribe;
}

interface ResolvedWebRtc {
  enabled: boolean;
  iceServers: NonNullable<P2PLinkClientConfig["webrtc"]>["iceServers"];
  engine?: WebRtcEngine;
  chunkSize?: number;
  maxQueuedBytes?: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  jitter: number;
}

interface ResolvedConfig {
  config: P2PLinkClientConfig;
  tenant: string;
  limits: P2PLinkLimits;
  webrtc: ResolvedWebRtc;
  logger: import("@p2plink/core").Logger;
}

interface HandshakeWaiter {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  unsubscribe: Unsubscribe;
  timer: ReturnType<typeof setTimeout>;
}

export class P2PLinkClientImpl<C extends RpcContract, E extends EventContract>
  implements P2PLinkClient<C, E>
{
  private readonly resolved: ResolvedConfig;
  private readonly defaultEngineFactory: (() => WebRtcEngine) | null;
  private identityValue: ClientIdentity | null = null;
  private mqtt: MqttConnection | null = null;
  private endpoint: MqttSessionEndpoint | null = null;
  private manager: TransportManager | null = null;
  private rpc: RpcClient<C, E> | null = null;
  private security: TransportSecurity | null = null;
  private webrtcTransport: WebRtcTransport | null = null;
  private sessionId: string | null = null;
  private clientId: string | null = null;
  private epoch = 0;
  private connectPromise: Promise<void> | null = null;
  private connected = false;
  private closed = false;
  private reconnecting = false;
  private lifecycleCleanup: Unsubscribe[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempts = 0;
  private resetsInWindow: number[] = [];
  private readonly statusListeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  private readonly eventListeners = new Map<string, Set<(payload: unknown) => void>>();
  private snapshot: ConnectionSnapshot;

  constructor(config: P2PLinkClientConfig, defaultEngineFactory: (() => WebRtcEngine) | null) {
    this.resolved = resolveConfig(config);
    this.defaultEngineFactory = defaultEngineFactory;
    this.snapshot = {
      status: "connecting",
      transport: null,
      sessionId: null,
      clientId: config.clientId ?? null,
      serverId: config.serverId,
      rttMs: null,
      rttByTransport: {},
      lastError: null,
      connectedAt: null,
      pendingRequests: 0,
      since: Date.now(),
    };
  }

  async connect(): Promise<void> {
    if (this.closed) this.closed = false;
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.reconnecting = false;
    this.clearLifecycle();
    await this.teardownSession();
    this.sessionId = null;
    this.setSnapshot({
      ...this.snapshot,
      status: "closed",
      transport: null,
      sessionId: null,
      rttMs: null,
      rttByTransport: {},
      since: Date.now(),
    });
  }

  request<K extends keyof C & string>(
    method: K,
    ...args: C[K]["request"] extends void | undefined
      ? [request?: C[K]["request"], options?: RequestOptions]
      : [request: C[K]["request"], options?: RequestOptions]
  ): Promise<C[K]["response"]> {
    if (!this.rpc) {
      return Promise.reject(
        new P2PLinkError(
          this.closed ? P2PLinkErrorCodes.CLOSED : P2PLinkErrorCodes.OFFLINE,
          this.closed ? "Client is closed" : "Client is not connected",
        ),
      );
    }
    const [request, options] = args as [unknown, RequestOptions | undefined];
    const call = this.rpc.request.bind(this.rpc) as unknown as (
      name: string,
      request?: unknown,
      options?: RequestOptions,
    ) => Promise<C[K]["response"]>;
    return call(method, request, options);
  }

  on<K extends keyof E & string>(event: K, listener: (payload: E[K]) => void): Unsubscribe {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    const wrapped = listener as (payload: unknown) => void;
    set.add(wrapped);
    return () => set?.delete(wrapped);
  }

  getStatus(): ConnectionSnapshot {
    return this.snapshot;
  }

  onStatus(listener: (snapshot: ConnectionSnapshot) => void): Unsubscribe {
    this.statusListeners.add(listener);
    listener(this.snapshot);
    return () => this.statusListeners.delete(listener);
  }

  private async doConnect(): Promise<void> {
    this.setSnapshot({
      ...this.snapshot,
      status: "connecting",
      clientId: this.clientId ?? this.resolved.config.clientId ?? null,
      since: Date.now(),
    });
    try {
      const identity = await this.resolveIdentity();
      const requestedClientId =
        this.resolved.config.clientId ?? `client-${randomToken(8)}`;
      const bootstrap = validateBootstrapResult(
        await this.resolved.config.bootstrap.bootstrap({
          protocolVersion: 1,
          clientId: requestedClientId,
          tenant: this.resolved.tenant,
          serverId: this.resolved.config.serverId,
          identityId: identity.identityId,
          identityPublicKey: identity.publicKeyJwk,
          requestId: randomId(),
        }),
      );
      validatePublicJwk(bootstrap.server.publicKeyJwk);
      if (this.resolved.config.security?.serverIdentity) {
        await assertServerIdentity(
          bootstrap.server.publicKeyJwk,
          this.resolved.config.security.serverIdentity,
        );
      }
      this.assertOpen();
      this.clientId = bootstrap.clientId;

      const credentials = await this.resolveMqttCredentials(bootstrap);
      const mqttOptions = this.resolved.config.mqtt;
      const connection = new MqttConnection({
        url: credentials.url,
        clientId: credentials.clientId ?? `p2p-${randomToken(8)}`,
        ...(credentials.username === undefined ? {} : { username: credentials.username }),
        ...(credentials.password === undefined ? {} : { password: credentials.password }),
        ...(mqttOptions?.keepaliveSeconds === undefined
          ? {}
          : { keepaliveSeconds: mqttOptions.keepaliveSeconds }),
        ...(mqttOptions?.reconnectPeriodMs === undefined
          ? {}
          : { reconnectPeriodMs: mqttOptions.reconnectPeriodMs }),
        ...(mqttOptions?.connectTimeoutMs === undefined
          ? {}
          : { connectTimeoutMs: mqttOptions.connectTimeoutMs }),
        maxPayloadBytes: this.resolved.limits.maxFrameBytes,
        logger: this.resolved.logger,
      });
      this.mqtt = connection;
      await connection.connect();
      this.assertOpen();

      const sessionId = randomToken(24);
      const endpoint = new MqttSessionEndpoint(
        connection,
        sessionTopics({
          tenant: this.resolved.tenant,
          serverId: this.resolved.config.serverId,
          clientId: bootstrap.clientId,
        }),
        { maxFrameBytes: this.resolved.limits.maxFrameBytes, logger: this.resolved.logger },
      );
      this.endpoint = endpoint;
      await endpoint.start();
      endpoint.onReset((reason) => {
        void this.handleSessionReset(reason);
      });

      const helloState = await createClientHello({
        tenant: this.resolved.tenant,
        serverId: this.resolved.config.serverId,
        clientId: bootstrap.clientId,
        sessionId,
        capability: bootstrap.capability,
        identity,
        now: Date.now,
      });
      const serverHelloPromise = this.waitForServerHello(endpoint, sessionId);
      await endpoint.sendHandshake(helloState.hello);
      const serverHello = await serverHelloPromise;
      const derived = await completeClientHandshake(helloState, serverHello, {
        serverIdentityPin: { publicKeyJwk: bootstrap.server.publicKeyJwk },
        ...(this.resolved.config.security?.clockSkewMs === undefined
          ? {}
          : { clockSkewMs: this.resolved.config.security.clockSkewMs }),
      });
      this.assertOpen();
      this.sessionId = sessionId;
      const security = new TransportSecurity(derived, "client", {
        maxFrameBytes: this.resolved.limits.maxFrameBytes,
      });
      this.security = security;

      const mqttTransport = new MqttTransport(endpoint, {
        maxFrameBytes: this.resolved.limits.maxFrameBytes,
      });
      const manager = new TransportManager({
        sessionId,
        clientId: bootstrap.clientId,
        serverId: this.resolved.config.serverId,
        transports: { mqtt: mqttTransport },
        security,
        limits: this.resolved.limits,
        logger: this.resolved.logger,
        onTransportChange: (from, to) => {
          this.rpc?.handleTransportChange(from, to);
        },
        onUnhealthy: (kind) => {
          if (kind === "webrtc") this.renegotiate("unhealthy");
        },
      });
      this.manager = manager;
      const rpc = new RpcClient<C, E>({
        sessionId,
        send: (envelope, options) => manager.send(envelope, options),
        timeoutMs: this.resolved.limits.requestTimeoutMs,
        maxPendingRequests: this.resolved.limits.maxPendingRequests,
        logger: this.resolved.logger,
        onPendingChange: (count) => manager.setPendingRequests(count),
      });
      this.rpc = rpc;
      rpc.onAnyEvent((event, payload) => {
        for (const listener of this.eventListeners.get(event) ?? []) {
          try {
            listener(payload);
          } catch (error) {
            this.resolved.logger.error("event listener failed", {
              event,
              error: P2PLinkError.from(error).message,
            });
          }
        }
      });
      manager.onEnvelope((envelope) => {
        if (envelope.type === "signal") {
          this.handleSignal(envelope.payload as SignalPayload);
        } else {
          rpc.handleEnvelope(envelope);
        }
      });
      manager.onStatus((snapshot) => this.handleManagerStatus(snapshot));
      manager.start();
      await manager.waitForTransport(this.resolved.limits.heartbeatTimeoutMs + 2_000);
      this.assertOpen();
      this.connected = true;
      this.reconnecting = false;
      this.retryAttempts = 0;
      this.setupLifecycle();
      this.startP2P();
    } catch (error) {
      const normalized = P2PLinkError.from(error);
      await this.teardownSession();
      this.sessionId = null;
      this.setSnapshot({
        ...this.snapshot,
        status: this.closed ? "closed" : "offline",
        transport: null,
        sessionId: null,
        lastError: normalized.toJSON(),
        since: Date.now(),
      });
      throw normalized;
    }
  }

  private async resolveIdentity(): Promise<ClientIdentity> {
    if (this.identityValue) return this.identityValue;
    const configured = this.resolved.config.security?.identity;
    if (configured) {
      const identity =
        typeof configured === "function" ? await configured() : configured;
      validatePublicJwk(identity.publicKeyJwk);
      if (typeof identity.sign !== "function") {
        throw new P2PLinkError(P2PLinkErrorCodes.INVALID_CONFIG, "Identity sign() is required");
      }
      this.identityValue = identity;
    } else {
      const identityId = this.resolved.config.clientId ?? `identity-${randomToken(8)}`;
      this.identityValue = await generateIdentity(identityId);
    }
    return this.identityValue;
  }

  private async resolveMqttCredentials(bootstrap: BootstrapResult): Promise<{
    url: string;
    username?: string;
    password?: string;
    clientId?: string;
  }> {
    const dynamic = this.resolved.config.mqtt?.credentials
      ? await this.resolved.config.mqtt.credentials()
      : undefined;
    const url =
      dynamic?.url ?? this.resolved.config.mqtt?.url ?? bootstrap.mqtt?.url;
    if (!url) {
      throw new P2PLinkError(
        P2PLinkErrorCodes.INVALID_CONFIG,
        "No MQTT URL configured or returned by bootstrap",
      );
    }
    const username =
      dynamic?.username ??
      this.resolved.config.mqtt?.username ??
      bootstrap.mqtt?.username;
    const password =
      dynamic?.password ??
      this.resolved.config.mqtt?.password ??
      bootstrap.mqtt?.password;
    const mqttClientId = this.resolved.config.mqtt?.clientId ?? bootstrap.mqtt?.clientId;
    return {
      url,
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
      ...(mqttClientId === undefined ? {} : { clientId: mqttClientId }),
    };
  }

  private waitForServerHello(
    endpoint: MqttSessionEndpoint,
    sessionId: string,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let waiter: HandshakeWaiter | null = null;
      const onReset = (reason: string): void => {
        if (!waiter) return;
        clearTimeout(waiter.timer);
        waiter.unsubscribe();
        waiter = null;
        resetUnsubscribe();
        reject(
          new P2PLinkError(P2PLinkErrorCodes.SESSION_RESET, `Server reset the session: ${reason}`),
        );
      };
      const unsubscribe = endpoint.onHandshake((message) => {
        if (
          typeof message !== "object" ||
          message === null ||
          (message as { kind?: unknown }).kind !== "server-hello" ||
          (message as { sessionId?: unknown }).sessionId !== sessionId
        ) {
          return;
        }
        if (!waiter) return;
        clearTimeout(waiter.timer);
        waiter.unsubscribe();
        waiter = null;
        resetUnsubscribe();
        resolve(message);
      });
      const resetUnsubscribe = endpoint.onReset(onReset);
      const timer = setTimeout(() => {
        if (!waiter) return;
        waiter = null;
        unsubscribe();
        resetUnsubscribe();
        reject(
          new P2PLinkError(P2PLinkErrorCodes.TIMEOUT, "Timed out waiting for the server handshake", {
            retryable: true,
          }),
        );
      }, this.resolved.limits.handshakeTimeoutMs);
      timer.unref?.();
      waiter = { resolve, reject, unsubscribe, timer };
    });
  }

  private handleSignal(signal: SignalPayload): void {
    if (!this.webrtcTransport) return;
    void this.webrtcTransport.handleSignal(signal);
  }

  private startP2P(): void {
    if (!this.resolved.webrtc.enabled) return;
    void this.negotiate();
  }

  private async negotiate(): Promise<void> {
    if (
      this.closed ||
      !this.manager ||
      !this.sessionId ||
      !this.manager.isReady()
    ) {
      return;
    }
    if (
      this.webrtcTransport &&
      (this.webrtcTransport.state === "connecting" || this.webrtcTransport.state === "open")
    ) {
      return;
    }
    let engine: WebRtcEngine;
    try {
      engine = this.resolved.webrtc.engine ?? this.defaultEngineFactory?.() ?? createBrowserWebRtcEngine();
    } catch (error) {
      this.resolved.logger.warn("WebRTC engine unavailable; staying on MQTT", {
        error: P2PLinkError.from(error).message,
      });
      return;
    }
    const negotiationId = randomToken(8);
    const sessionId = this.sessionId;
    const manager = this.manager;
    const transport = new WebRtcTransport({
      engine,
      role: "offerer",
      negotiationId,
      epoch: this.epoch++,
      iceServers: this.resolved.webrtc.iceServers ?? [],
      sendSignal: async (signal) => {
        await manager.send(
          createEnvelope("signal", sessionId, signal),
          { via: "mqtt" },
        );
      },
      maxFrameBytes: this.resolved.limits.maxFrameBytes,
      ...(this.resolved.webrtc.chunkSize === undefined
        ? {}
        : { chunkSize: this.resolved.webrtc.chunkSize }),
      ...(this.resolved.webrtc.maxQueuedBytes === undefined
        ? {}
        : { maxQueuedBytes: this.resolved.webrtc.maxQueuedBytes }),
      logger: this.resolved.logger,
    });
    this.webrtcTransport = transport;
    manager.setTransport("webrtc", transport);
    transport.onStateChange((state) => {
      if (this.webrtcTransport !== transport) return;
      if (state === "failed" || state === "closed") {
        this.webrtcTransport = null;
        this.scheduleRenegotiation("transport-" + state);
      }
    });
    try {
      await transport.start();
    } catch (error) {
      this.resolved.logger.warn("WebRTC negotiation failed", {
        error: P2PLinkError.from(error).message,
      });
      if (this.webrtcTransport === transport) {
        this.webrtcTransport = null;
        this.scheduleRenegotiation("negotiation-failed");
      }
    }
  }

  private renegotiate(reason: string): void {
    if (this.closed) return;
    const transport = this.webrtcTransport;
    this.webrtcTransport = null;
    if (transport) void transport.close();
    this.manager?.setTransport("webrtc", undefined);
    this.scheduleRenegotiation(reason);
  }

  private scheduleRenegotiation(reason: string, attemptOverride?: number): void {
    if (
      this.closed ||
      !this.resolved.webrtc.enabled ||
      !this.manager ||
      this.retryTimer
    ) {
      return;
    }
    const attempt = attemptOverride ?? this.retryAttempts;
    if (this.resolved.webrtc.maxAttempts > 0 && attempt >= this.resolved.webrtc.maxAttempts) {
      this.resolved.logger.warn("WebRTC reconnection attempts exhausted", { reason });
      return;
    }
    this.retryAttempts += 1;
    const base = Math.min(
      this.resolved.webrtc.maxDelayMs,
      this.resolved.webrtc.baseDelayMs * 2 ** attempt,
    );
    const jitter = 1 - this.resolved.webrtc.jitter / 2 + Math.random() * this.resolved.webrtc.jitter;
    const delay = Math.max(0, Math.round(base * jitter));
    this.resolved.logger.debug("scheduling WebRTC renegotiation", { reason, delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.negotiate();
    }, delay);
    this.retryTimer.unref?.();
  }

  private handleManagerStatus(snapshot: ConnectionSnapshot): void {
    this.setSnapshot({
      ...snapshot,
      clientId: this.clientId,
      lastError: snapshot.lastError ?? this.snapshot.lastError,
    });
    if (snapshot.status === "p2p") {
      this.retryAttempts = 0;
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
    }
    if (snapshot.status === "mqtt" && this.resolved.webrtc.enabled) {
      if (!this.webrtcTransport && !this.retryTimer && this.connected) {
        this.scheduleRenegotiation("mqtt-ready", 0);
      }
    }
  }

  private setupLifecycle(): void {
    this.clearLifecycle();
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      this.manager?.probeNow();
      if (!this.webrtcTransport || this.webrtcTransport.state !== "open") {
        this.retryAttempts = 0;
        this.scheduleRenegotiation("app-resume", 0);
      }
    };
    const onOnline = (): void => {
      this.manager?.probeNow();
      this.retryAttempts = 0;
      this.scheduleRenegotiation("network-online", 0);
    };
    const onOffline = (): void => {
      this.resolved.logger.info("browser went offline");
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    this.lifecycleCleanup.push(() => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    });
  }

  private clearLifecycle(): void {
    for (const cleanup of this.lifecycleCleanup.splice(0)) cleanup();
  }

  private async handleSessionReset(reason: string): Promise<void> {
    if (this.closed || this.reconnecting) return;
    const now = Date.now();
    this.resetsInWindow = this.resetsInWindow.filter((time) => now - time < 60_000);
    if (this.resetsInWindow.length >= 3) {
      this.resolved.logger.error("too many session resets; giving up", { reason });
      this.setSnapshot({
        ...this.snapshot,
        status: "offline",
        lastError: {
          code: P2PLinkErrorCodes.SESSION_RESET,
          message: "Too many session resets",
          retryable: false,
          outcomeUnknown: false,
        },
        since: now,
      });
      return;
    }
    this.resetsInWindow.push(now);
    this.reconnecting = true;
    this.connected = false;
    this.rpc?.failAll(
      new P2PLinkError(
        P2PLinkErrorCodes.SESSION_RESET,
        `Session reset by server: ${reason}`,
        { retryable: true, outcomeUnknown: true },
      ),
    );
    this.setSnapshot({
      ...this.snapshot,
      status: "reconnecting",
      transport: null,
      lastError: {
        code: P2PLinkErrorCodes.SESSION_RESET,
        message: reason,
        retryable: true,
        outcomeUnknown: false,
      },
      since: now,
    });
    this.clearLifecycle();
    await this.teardownSession();
    this.sessionId = null;
    this.reconnecting = false;
    if (!this.closed) {
      setTimeout(() => {
        void this.connect().catch((error: unknown) => {
          this.resolved.logger.error("session re-establishment failed", {
            error: P2PLinkError.from(error).message,
          });
        });
      }, 750);
    }
  }

  private async teardownSession(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const transport = this.webrtcTransport;
    this.webrtcTransport = null;
    if (transport) await transport.close().catch(() => undefined);
    const manager = this.manager;
    this.manager = null;
    if (manager) manager.stop();
    this.rpc?.close();
    this.rpc = null;
    const endpoint = this.endpoint;
    this.endpoint = null;
    if (endpoint) await endpoint.close().catch(() => undefined);
    const mqtt = this.mqtt;
    this.mqtt = null;
    if (mqtt) await mqtt.close().catch(() => undefined);
    this.security = null;
  }

  private setSnapshot(snapshot: ConnectionSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.resolved.logger.error("status listener failed", {
          error: P2PLinkError.from(error).message,
        });
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new P2PLinkError(P2PLinkErrorCodes.CLOSED, "Client is closed");
    }
  }
}

function resolveConfig(config: P2PLinkClientConfig): ResolvedConfig {
  if (!config.serverId) {
    throw new P2PLinkError(P2PLinkErrorCodes.INVALID_CONFIG, "serverId is required");
  }
  if (!config.bootstrap) {
    throw new P2PLinkError(P2PLinkErrorCodes.INVALID_CONFIG, "bootstrap provider is required");
  }
  const reconnect = config.webrtc?.reconnect;
  return {
    config,
    tenant: config.tenant ?? "default",
    limits: { ...DEFAULT_LIMITS, ...config.limits },
    logger: config.logger ?? noopLogger,
    webrtc: {
      enabled: config.webrtc?.enabled ?? true,
      iceServers: config.webrtc?.iceServers ?? [],
      ...(config.webrtc?.engine === undefined ? {} : { engine: config.webrtc.engine }),
      ...(config.webrtc?.chunkSize === undefined ? {} : { chunkSize: config.webrtc.chunkSize }),
      ...(config.webrtc?.maxQueuedBytes === undefined
        ? {}
        : { maxQueuedBytes: config.webrtc.maxQueuedBytes }),
      baseDelayMs: reconnect?.baseDelayMs ?? 1_000,
      maxDelayMs: reconnect?.maxDelayMs ?? 30_000,
      maxAttempts: reconnect?.maxAttempts ?? 12,
      jitter: reconnect?.jitter ?? 0.5,
    },
  };
}

