import {
  P2PLinkError,
  P2PLinkErrorCodes,
  type Transport,
  type TransportKind,
  type TransportState,
  type Unsubscribe,
} from "@p2plink/core";

/** Common shape of client and server MQTT session endpoints. */
export interface MqttFrameEndpoint {
  readonly state: TransportState;
  sendFrame(frame: Uint8Array): Promise<void>;
  onFrame(listener: (frame: Uint8Array) => void): Unsubscribe;
  onStateChange(listener: (state: TransportState) => void): Unsubscribe;
  close(): Promise<void> | void;
}

export class MqttTransport implements Transport {
  readonly kind: TransportKind = "mqtt";
  private readonly endpoint: MqttFrameEndpoint;
  private readonly maxFrameBytes: number;

  constructor(endpoint: MqttFrameEndpoint, options: { maxFrameBytes?: number } = {}) {
    this.endpoint = endpoint;
    this.maxFrameBytes = options.maxFrameBytes ?? 256 * 1024;
  }

  get state(): TransportState {
    return this.endpoint.state;
  }

  async send(data: Uint8Array): Promise<void> {
    if (data.length > this.maxFrameBytes) {
      throw new P2PLinkError(P2PLinkErrorCodes.PAYLOAD_TOO_LARGE, "MQTT frame too large");
    }
    if (this.endpoint.state !== "open") {
      throw new P2PLinkError(P2PLinkErrorCodes.TRANSPORT_UNAVAILABLE, "MQTT transport is closed", {
        retryable: true,
      });
    }
    await this.endpoint.sendFrame(data);
  }

  onData(listener: (data: Uint8Array) => void): Unsubscribe {
    return this.endpoint.onFrame(listener);
  }

  onStateChange(listener: (state: TransportState) => void): Unsubscribe {
    return this.endpoint.onStateChange(listener);
  }

  async close(): Promise<void> {
    await this.endpoint.close();
  }
}
