import type { Logger, Unsubscribe } from "@p2plink/core";
import type { WebRtcEngine } from "@p2plink/webrtc";

export type PeerKind = "browser" | "nest";
export type PeerRoute = "p2p" | "mqtt" | "connecting";

export interface MeshPeerConfig {
  /** MQTT broker URL: mqtt:// or mqtts:// in Node, ws:// or wss:// in browsers. */
  url: string;
  username?: string;
  password?: string;
  /** MQTT client id. Generated when omitted. */
  clientId?: string;
  /** Human-readable name shown by other peers. */
  name: string;
  kind: PeerKind;
  /** Random payload size for each ping request/response, in bytes. */
  pingBytes: number;
  /** Provided by the host: browser or Node engine. */
  engine: WebRtcEngine;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  presenceIntervalMs?: number;
  peerTtlMs?: number;
  disableWebRtc?: boolean;
  logger?: Logger;
}

export interface PeerStats {
  peerId: string;
  name: string;
  kind: PeerKind;
  route: PeerRoute;
  rttMs: number | null;
  p2pBytes: number;
  mqttBytes: number;
  p2pBytesPerSec: number;
  mqttBytesPerSec: number;
  pings: number;
  roundTrips: number;
  lastPingAt: number | null;
  lastError: string | null;
}

export interface MeshTotals {
  peers: number;
  p2pBytes: number;
  mqttBytes: number;
  p2pBytesPerSec: number;
  mqttBytesPerSec: number;
}

export interface MeshSnapshot {
  self: { peerId: string; name: string; kind: PeerKind };
  brokerConnected: boolean;
  webRtcEnabled: boolean;
  peers: PeerStats[];
  totals: MeshTotals;
  updatedAt: number;
}

export interface MeshPeer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getSnapshot(): MeshSnapshot;
  onSnapshot(listener: (snapshot: MeshSnapshot) => void): Unsubscribe;
  setWebRtcEnabled(enabled: boolean): void;
  resetStats(): void;
}

export interface RemotePeer {
  peerId: string;
  name: string;
  kind: PeerKind;
  identityId: string;
  identityPublicKey: JsonWebKey;
  lastSeen: number;
}

export interface PresenceMessage {
  v: 1;
  type: "presence" | "leave";
  peerId: string;
  name: string;
  kind: PeerKind;
  identityId: string;
  identityPublicKey: JsonWebKey;
  ts: number;
}

export interface HandshakeMessage {
  v: 1;
  type: "handshake";
  sessionId: string;
  hello: unknown;
}

export interface PairView {
  peerId: string;
  name: string;
  kind: PeerKind;
  route: PeerRoute;
  rttMs: number | null;
  p2pBytes: number;
  mqttBytes: number;
  p2pBytesPerSec: number;
  mqttBytesPerSec: number;
  pings: number;
  roundTrips: number;
  lastPingAt: number | null;
  lastError: string | null;
}
