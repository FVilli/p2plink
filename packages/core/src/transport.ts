import type { TransportKind, TransportState, Unsubscribe } from "./types.js";

/**
 * A byte transport. Encryption, replay protection and message framing are
 * handled above this interface by the session layer.
 */
export interface Transport {
  readonly kind: TransportKind;
  readonly state: TransportState;
  send(data: Uint8Array): Promise<void>;
  onData(listener: (data: Uint8Array) => void): Unsubscribe;
  onStateChange(listener: (state: TransportState) => void): Unsubscribe;
  close(): Promise<void>;
}

/** Seals and opens application frames for a specific transport. */
export interface SessionSecurity {
  readonly sessionId: string;
  seal(transport: TransportKind, plaintext: Uint8Array): Promise<Uint8Array>;
  open(transport: TransportKind, frame: Uint8Array): Promise<Uint8Array>;
  destroy(): void;
}

export interface TransportSendOptions {
  /** Force a transport (used for WebRTC signaling, which always travels on MQTT). */
  via?: TransportKind;
}
