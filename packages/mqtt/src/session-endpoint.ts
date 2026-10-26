import {
  P2PLinkError,
  P2PLinkErrorCodes,
  decodeHandshakeMessage,
  encodeHandshakeMessage,
  isSecureFrame,
  noopLogger,
  validateSignalReset,
  type Logger,
  type SessionTopics,
  type TransportState,
  type Unsubscribe,
} from "@p2plink/core";
import { utf8Decode } from "@p2plink/core";
import type { MqttConnection } from "./connection.js";
import type { MqttFrameEndpoint } from "./transport.js";

export interface MqttSessionEndpointOptions {
  maxFrameBytes?: number;
  logger?: Logger;
}

/**
 * Client-side endpoint for one session. It subscribes to the client's session
 * and control topics and publishes only to its own c2s topic.
 */
export class MqttSessionEndpoint implements MqttFrameEndpoint {
  private readonly connection: MqttConnection;
  private readonly topics: SessionTopics;
  private readonly maxFrameBytes: number;
  private readonly logger: Logger;
  private readonly handshakeListeners = new Set<(message: unknown) => void>();
  private readonly frameListeners = new Set<(frame: Uint8Array) => void>();
  private readonly resetListeners = new Set<(reason: string) => void>();
  private readonly unsubscribers: Unsubscribe[] = [];
  private started = false;

  constructor(
    connection: MqttConnection,
    topics: SessionTopics,
    options: MqttSessionEndpointOptions = {},
  ) {
    this.connection = connection;
    this.topics = topics;
    this.maxFrameBytes = options.maxFrameBytes ?? 256 * 1024;
    this.logger = options.logger ?? noopLogger;
  }

  get state(): TransportState {
    return this.connection.state;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribers.push(
      await this.connection.subscribeAsync(
        this.topics.sessionS2c,
        (_topic, payload) => this.handleSessionPayload(payload),
        1,
      ),
    );
    this.unsubscribers.push(
      await this.connection.subscribeAsync(
        this.topics.signalS2c,
        (_topic, payload) => this.handleControlPayload(payload),
        1,
      ),
    );
  }

  sendHandshake(message: unknown): Promise<void> {
    return this.connection.publish(this.topics.sessionC2s, encodeHandshakeMessage(message), 1);
  }

  async sendFrame(frame: Uint8Array): Promise<void> {
    if (!isSecureFrame(frame)) {
      throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Refusing to send a non-secure frame");
    }
    if (frame.length > this.maxFrameBytes) {
      throw new P2PLinkError(P2PLinkErrorCodes.PAYLOAD_TOO_LARGE, "Frame too large");
    }
    await this.connection.publish(this.topics.sessionC2s, frame, 1);
  }

  onHandshake(listener: (message: unknown) => void): Unsubscribe {
    this.handshakeListeners.add(listener);
    return () => this.handshakeListeners.delete(listener);
  }

  onFrame(listener: (frame: Uint8Array) => void): Unsubscribe {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onReset(listener: (reason: string) => void): Unsubscribe {
    this.resetListeners.add(listener);
    return () => this.resetListeners.delete(listener);
  }

  onStateChange(listener: (state: TransportState) => void): Unsubscribe {
    return this.connection.onStateChange(listener);
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.handshakeListeners.clear();
    this.frameListeners.clear();
    this.resetListeners.clear();
    this.started = false;
  }

  private handleSessionPayload(payload: Uint8Array): void {
    if (payload.length === 0) return;
    try {
      if (payload[0] === 0x01) {
        const message = decodeHandshakeMessage(payload);
        for (const listener of this.handshakeListeners) listener(message);
      } else if (payload[0] === 0x02) {
        if (payload.length > this.maxFrameBytes) {
          this.logger.warn("dropping oversized MQTT frame", { size: payload.length });
          return;
        }
        for (const listener of this.frameListeners) listener(payload);
      }
    } catch (error) {
      this.logger.warn("invalid session payload", {
        error: P2PLinkError.from(error).message,
      });
    }
  }

  private handleControlPayload(payload: Uint8Array): void {
    try {
      const value = JSON.parse(utf8Decode(payload)) as unknown;
      validateSignalReset(value);
      if (value.kind === "session-reset") {
        for (const listener of this.resetListeners) listener(value.reason);
      }
    } catch (error) {
      this.logger.warn("invalid control payload", {
        error: P2PLinkError.from(error).message,
      });
    }
  }
}
