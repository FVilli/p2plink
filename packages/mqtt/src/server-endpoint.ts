import {
  P2PLinkError,
  P2PLinkErrorCodes,
  decodeHandshakeMessage,
  encodeHandshakeMessage,
  isSecureFrame,
  noopLogger,
  serverSessionSubscription,
  sessionClientIdFromTopic,
  sessionTopics,
  assertTopicPart,
  type Logger,
  type TransportState,
  type Unsubscribe,
} from "@p2plink/core";
import type { MqttConnection } from "./connection.js";
import type { MqttFrameEndpoint } from "./transport.js";

export interface MqttServerEndpointOptions {
  tenant: string;
  serverId: string;
  maxFrameBytes?: number;
  logger?: Logger;
}

interface ClientRegistration {
  frameListeners: Set<(frame: Uint8Array) => void>;
  lastResetAt: number;
}

/** Server-side per-client sender/receiver endpoint. */
export class MqttServerClientEndpoint implements MqttFrameEndpoint {
  private readonly server: MqttServerEndpoint;
  readonly clientId: string;
  private readonly registration: ClientRegistration;
  private closed = false;

  constructor(server: MqttServerEndpoint, clientId: string, registration: ClientRegistration) {
    this.server = server;
    this.clientId = clientId;
    this.registration = registration;
  }

  get state(): TransportState {
    return this.server.state;
  }

  sendHandshake(message: unknown): Promise<void> {
    return this.server.publishToClient(this.clientId, encodeHandshakeMessage(message));
  }

  sendFrame(frame: Uint8Array): Promise<void> {
    if (!isSecureFrame(frame)) {
      return Promise.reject(
        new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Refusing to send a non-secure frame"),
      );
    }
    return this.server.publishToClient(this.clientId, frame);
  }

  onFrame(listener: (frame: Uint8Array) => void): Unsubscribe {
    this.registration.frameListeners.add(listener);
    return () => this.registration.frameListeners.delete(listener);
  }

  onStateChange(listener: (state: TransportState) => void): Unsubscribe {
    return this.server.onStateChange(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.registration.frameListeners.clear();
    this.server.unregisterClient(this.clientId, this.registration);
  }
}

/**
 * Server-side MQTT endpoint: one shared connection handles all clients,
 * subscribing once to the tenant/server wildcard topic.
 */
export class MqttServerEndpoint {
  private readonly connection: MqttConnection;
  private readonly options: MqttServerEndpointOptions;
  private readonly logger: Logger;
  private readonly handshakeListeners = new Set<
    (clientId: string, message: unknown) => void
  >();
  private readonly clients = new Map<string, ClientRegistration>();
  private readonly lastResetAt = new Map<string, number>();
  private unsubscribe: Unsubscribe | null = null;
  private started = false;

  constructor(connection: MqttConnection, options: MqttServerEndpointOptions) {
    this.connection = connection;
    this.options = options;
    this.logger = options.logger ?? noopLogger;
  }

  get state(): TransportState {
    return this.connection.state;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = await this.connection.subscribeAsync(
      serverSessionSubscription(this.options.tenant, this.options.serverId),
      (topic, payload) => this.handleMessage(topic, payload),
      1,
    );
  }

  onHandshake(listener: (clientId: string, message: unknown) => void): Unsubscribe {
    this.handshakeListeners.add(listener);
    return () => this.handshakeListeners.delete(listener);
  }

  forClient(clientId: string): MqttServerClientEndpoint {
    assertTopicPart("clientId", clientId);
    let registration = this.clients.get(clientId);
    if (!registration) {
      registration = { frameListeners: new Set(), lastResetAt: 0 };
      this.clients.set(clientId, registration);
    }
    return new MqttServerClientEndpoint(this, clientId, registration);
  }

  onStateChange(listener: (state: TransportState) => void): Unsubscribe {
    return this.connection.onStateChange(listener);
  }

  async publishToClient(clientId: string, payload: Uint8Array): Promise<void> {
    if (payload.length > (this.options.maxFrameBytes ?? 256 * 1024)) {
      throw new P2PLinkError(P2PLinkErrorCodes.PAYLOAD_TOO_LARGE, "Payload too large");
    }
    const topics = sessionTopics({
      tenant: this.options.tenant,
      serverId: this.options.serverId,
      clientId,
    });
    await this.connection.publish(topics.sessionS2c, payload, 1);
  }

  async publishSessionReset(clientId: string, sessionId: string | undefined, reason: string): Promise<void> {
    const topics = sessionTopics({
      tenant: this.options.tenant,
      serverId: this.options.serverId,
      clientId,
    });
    const reset = {
      v: 1,
      kind: "session-reset" as const,
      ...(sessionId === undefined ? {} : { sessionId }),
      reason,
    };
    await this.connection.publish(topics.signalS2c, JSON.stringify(reset), 1);
  }

  unregisterClient(clientId: string, registration: ClientRegistration): void {
    if (this.clients.get(clientId) === registration) this.clients.delete(clientId);
  }

  onFrameForClient(clientId: string, listener: (frame: Uint8Array) => void): Unsubscribe {
    const registration = this.clients.get(clientId);
    if (!registration) {
      throw new P2PLinkError(P2PLinkErrorCodes.INVALID_CONFIG, `Unknown client ${clientId}`);
    }
    registration.frameListeners.add(listener);
    return () => registration.frameListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const registration of this.clients.values()) registration.frameListeners.clear();
    this.clients.clear();
    this.handshakeListeners.clear();
    this.started = false;
  }

  private handleMessage(topic: string, payload: Uint8Array): void {
    const clientId = sessionClientIdFromTopic(topic);
    if (!clientId) return;
    if (payload.length === 0) return;
    if (payload[0] === 0x01) {
      let message: unknown;
      try {
        message = decodeHandshakeMessage(payload);
      } catch (error) {
        this.logger.warn("invalid handshake payload", {
          clientId,
          error: P2PLinkError.from(error).message,
        });
        return;
      }
      for (const listener of this.handshakeListeners) {
        try {
          listener(clientId, message);
        } catch (error) {
          this.logger.error("handshake listener failed", {
            clientId,
            error: P2PLinkError.from(error).message,
          });
        }
      }
      return;
    }
    if (payload[0] !== 0x02) return;
    if (payload.length > (this.options.maxFrameBytes ?? 256 * 1024)) {
      this.logger.warn("dropping oversized frame", { clientId, size: payload.length });
      return;
    }
    const registration = this.clients.get(clientId);
    if (!registration) {
      const now = Date.now();
      if (now - (this.lastResetAt.get(clientId) ?? 0) > 5_000) {
        this.lastResetAt.set(clientId, now);
        void this.publishSessionReset(clientId, undefined, "unknown-session").catch(() => undefined);
      }
      return;
    }
    for (const listener of registration.frameListeners) {
      try {
        listener(payload);
      } catch (error) {
        this.logger.error("frame listener failed", {
          clientId,
          error: P2PLinkError.from(error).message,
        });
      }
    }
  }
}
