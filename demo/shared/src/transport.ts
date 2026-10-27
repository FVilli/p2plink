import {
  P2PLinkError,
  P2PLinkErrorCodes,
  type Transport,
  type TransportKind,
  type TransportState,
  type Unsubscribe,
} from "@p2plink/core";
import type { MqttConnection } from "@p2plink/mqtt";

/** MQTT fallback transport for one directed peer pair. */
export class DemoMqttTransport implements Transport {
  readonly kind: TransportKind = "mqtt";
  private readonly connection: MqttConnection;
  private readonly outTopic: string;
  private readonly inTopic: string;
  private readonly maxFrameBytes: number;
  private readonly unsubscribers = new Set<Unsubscribe>();
  private closed = false;

  constructor(
    connection: MqttConnection,
    outTopic: string,
    inTopic: string,
    maxFrameBytes: number,
  ) {
    this.connection = connection;
    this.outTopic = outTopic;
    this.inTopic = inTopic;
    this.maxFrameBytes = maxFrameBytes;
  }

  get state(): TransportState {
    return this.connection.state;
  }

  async send(data: Uint8Array): Promise<void> {
    if (this.closed || this.connection.state !== "open") {
      throw new P2PLinkError(P2PLinkErrorCodes.TRANSPORT_UNAVAILABLE, "MQTT is not connected", {
        retryable: true,
      });
    }
    if (data.length > this.maxFrameBytes) {
      throw new P2PLinkError(P2PLinkErrorCodes.PAYLOAD_TOO_LARGE, "Frame too large");
    }
    await this.connection.publish(this.outTopic, data, 1);
  }

  onData(listener: (data: Uint8Array) => void): Unsubscribe {
    const unsubscribe = this.connection.subscribe(
      this.inTopic,
      (_topic, payload) => {
        listener(payload);
      },
      1,
    );
    this.unsubscribers.add(unsubscribe);
    return () => {
      unsubscribe();
      this.unsubscribers.delete(unsubscribe);
    };
  }

  onStateChange(listener: (state: TransportState) => void): Unsubscribe {
    return this.connection.onStateChange(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.clear();
  }
}
