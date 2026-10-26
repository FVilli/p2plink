import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import {
  P2PLinkError,
  P2PLinkErrorCodes,
  noopLogger,
  randomToken,
  utf8Encode,
  type Logger,
  type TransportState,
  type Unsubscribe,
} from "@p2plink/core";
import { mqttTopicMatches } from "./topic-match.js";

export type QoS = 0 | 1 | 2;

export interface MqttConnectionOptions {
  url: string;
  clientId?: string;
  username?: string;
  password?: string;
  keepaliveSeconds?: number;
  connectTimeoutMs?: number;
  reconnectPeriodMs?: number;
  clean?: boolean;
  protocolVersion?: 4 | 5;
  logger?: Logger;
  /** Application-level maximum payload size for publish operations. */
  maxPayloadBytes?: number;
}

interface Subscription {
  filter: string;
  qos: QoS;
  handler: (topic: string, payload: Uint8Array) => void;
}

/**
 * Thin, typed wrapper around MQTT.js with deterministic state reporting,
 * binary payloads and automatic re-subscription after reconnects.
 */
export class MqttConnection {
  readonly clientId: string;
  private readonly options: MqttConnectionOptions;
  private readonly logger: Logger;
  private readonly subscriptions = new Set<Subscription>();
  private readonly stateListeners = new Set<(state: TransportState) => void>();
  private client: MqttClient | null = null;
  private _state: TransportState = "connecting";
  private closedByUser = false;

  constructor(options: MqttConnectionOptions) {
    this.options = options;
    this.clientId = options.clientId ?? `p2p-${randomToken(9)}`;
    this.logger = options.logger ?? noopLogger;
  }

  get state(): TransportState {
    return this._state;
  }

  get connected(): boolean {
    return this._state === "open";
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.closedByUser = false;
    this.setState("connecting");
    const options: IClientOptions = {
      clientId: this.clientId,
      clean: this.options.clean ?? true,
      keepalive: this.options.keepaliveSeconds ?? 30,
      connectTimeout: this.options.connectTimeoutMs ?? 10_000,
      reconnectPeriod: this.options.reconnectPeriodMs ?? 2_000,
      resubscribe: true,
      protocolVersion: this.options.protocolVersion ?? 4,
      ...(this.options.username === undefined ? {} : { username: this.options.username }),
      ...(this.options.password === undefined ? {} : { password: this.options.password }),
    };
    this.logger.debug("mqtt connecting", { url: this.options.url, clientId: this.clientId });
    const client = mqtt.connect(this.options.url, options);
    this.client = client;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new P2PLinkError(P2PLinkErrorCodes.TIMEOUT, "MQTT connection timed out", {
            retryable: true,
          }),
        );
      }, this.options.connectTimeoutMs ?? 10_000);

      client.on("connect", () => {
        this.setState("open");
        this.logger.info("mqtt connected", { url: this.options.url });
        void this.resubscribeAll();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
      client.on("reconnect", () => {
        this.logger.debug("mqtt reconnecting");
        this.setState("connecting");
      });
      client.on("offline", () => {
        this.setState("connecting");
      });
      client.on("close", () => {
        this.setState(this.closedByUser ? "closed" : "connecting");
      });
      client.on("error", (error) => {
        this.logger.warn("mqtt error", { message: error.message });
        this.setState("failed");
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          client.end(true);
          reject(
            new P2PLinkError(P2PLinkErrorCodes.TRANSPORT_UNAVAILABLE, "MQTT connection failed", {
              retryable: true,
              cause: error,
            }),
          );
        }
      });
      client.on("message", (topic, payload) => {
        const bytes = toBytes(payload);
        for (const subscription of this.subscriptions) {
          if (mqttTopicMatches(subscription.filter, topic)) {
            try {
              subscription.handler(topic, bytes);
            } catch (error) {
              this.logger.error("mqtt message handler failed", {
                topic,
                error: P2PLinkError.from(error).message,
              });
            }
          }
        }
      });
    });
  }

  async publish(topic: string, payload: Uint8Array | string, qos: QoS = 1): Promise<void> {
    const client = this.client;
    if (!client || this._state !== "open") {
      throw new P2PLinkError(P2PLinkErrorCodes.TRANSPORT_UNAVAILABLE, "MQTT is not connected", {
        retryable: true,
      });
    }
    const bytes = typeof payload === "string" ? utf8Encode(payload) : payload;
    if (bytes.length > (this.options.maxPayloadBytes ?? 256 * 1024)) {
      throw new P2PLinkError(P2PLinkErrorCodes.PAYLOAD_TOO_LARGE, "MQTT payload too large");
    }
    await new Promise<void>((resolve, reject) => {
      client.publish(topic, bytes as never, { qos }, (error) => {
        if (error) {
          reject(
            new P2PLinkError(P2PLinkErrorCodes.TRANSPORT_SEND_FAILED, error.message, {
              retryable: true,
              outcomeUnknown: true,
              cause: error,
            }),
          );
        } else {
          resolve();
        }
      });
    });
  }

  subscribe(
    filter: string,
    handler: (topic: string, payload: Uint8Array) => void,
    qos: QoS = 1,
  ): Unsubscribe {
    const subscription: Subscription = { filter, qos, handler };
    this.subscriptions.add(subscription);
    if (this.client && this._state === "open") {
      this.client.subscribe(filter, { qos }, (error) => {
        if (error) this.logger.error("mqtt subscribe failed", { filter, message: error.message });
      });
    }
    return () => {
      this.subscriptions.delete(subscription);
      if (
        this.client &&
        ![...this.subscriptions].some((candidate) => candidate.filter === filter)
      ) {
        this.client.unsubscribe(filter, () => undefined);
      }
    };
  }

  async subscribeAsync(
    filter: string,
    handler: (topic: string, payload: Uint8Array) => void,
    qos: QoS = 1,
  ): Promise<Unsubscribe> {
    const unsubscribe = this.subscribe(filter, handler, qos);
    const client = this.client;
    if (!client || this._state !== "open") return unsubscribe;
    await new Promise<void>((resolve, reject) => {
      client.subscribe(filter, { qos }, (error, granted) => {
        if (error) {
          reject(
            new P2PLinkError(P2PLinkErrorCodes.TRANSPORT_UNAVAILABLE, error.message, {
              retryable: true,
              cause: error,
            }),
          );
          return;
        }
        if (granted?.some((entry) => entry.qos === 128)) {
          reject(
            new P2PLinkError(P2PLinkErrorCodes.FORBIDDEN, `MQTT subscription denied: ${filter}`),
          );
          return;
        }
        resolve();
      });
    });
    return unsubscribe;
  }

  onStateChange(listener: (state: TransportState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    const client = this.client;
    this.client = null;
    this.setState("closed");
    if (!client) return;
    await new Promise<void>((resolve) => {
      client.end(false, {}, () => resolve());
    });
  }

  private async resubscribeAll(): Promise<void> {
    const client = this.client;
    if (!client || this.subscriptions.size === 0) return;
    for (const subscription of this.subscriptions) {
      client.subscribe(subscription.filter, { qos: subscription.qos }, (error) => {
        if (error) {
          this.logger.error("mqtt resubscribe failed", {
            filter: subscription.filter,
            message: error.message,
          });
        }
      });
    }
  }

  private setState(state: TransportState): void {
    if (this._state === state) return;
    this._state = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // Ignore listener failures.
      }
    }
  }
}

function toBytes(payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) return new Uint8Array(payload);
  if (typeof payload === "string") return utf8Encode(payload);
  return new Uint8Array(0);
}
