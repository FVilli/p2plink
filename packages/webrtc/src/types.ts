import type { IceCandidateInit, IceServer, SessionDescriptionInit, Unsubscribe } from "@p2plink/core";

export type PeerConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export type ChannelState = "connecting" | "open" | "closing" | "closed";

export interface DataChannelLike {
  readonly label: string;
  readonly readyState: ChannelState;
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  close(): void;
  onMessage(listener: (data: ArrayBuffer | Uint8Array | string) => void): Unsubscribe;
  onOpen(listener: () => void): Unsubscribe;
  onClose(listener: () => void): Unsubscribe;
  onError(listener: (error: unknown) => void): Unsubscribe;
  onBufferedAmountLow(listener: () => void): Unsubscribe;
  setBufferedAmountLowThreshold(value: number): void;
}

export interface PeerConnectionLike {
  createDataChannel(label: string): DataChannelLike;
  onDataChannel(listener: (channel: DataChannelLike) => void): Unsubscribe;
  createOffer(): Promise<SessionDescriptionInit>;
  createAnswer(): Promise<SessionDescriptionInit>;
  setLocalDescription(description: SessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: SessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: IceCandidateInit): Promise<void>;
  onIceCandidate(listener: (candidate: IceCandidateInit) => void): Unsubscribe;
  onConnectionState(listener: (state: PeerConnectionState) => void): Unsubscribe;
  localDescription(): SessionDescriptionInit | null;
  close(): void;
}

export interface WebRtcEngine {
  readonly name: string;
  createPeer(config: { iceServers: IceServer[] }): PeerConnectionLike;
}
