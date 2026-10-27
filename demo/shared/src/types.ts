import type { IceServer, Logger, Unsubscribe } from "@p2plink/core";
import type { WebRtcEngine } from "@p2plink/webrtc";

export type PeerKind = "browser" | "nest";
export type PeerRoute = "p2p" | "mqtt" | "connecting";
export type IssueLevel = "warn" | "error";

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
  version?: string;
  /** Platform/user-agent string included in diagnostics. */
  platform?: string;
  /** Random payload size for each ping request/response, in bytes. */
  pingBytes: number;
  /** Provided by the host: browser or Node engine. */
  engine: WebRtcEngine;
  iceServers?: IceServer[];
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /** Presence heartbeat interval. Default: 30 seconds. */
  presenceIntervalMs?: number;
  peerTtlMs?: number;
  disableWebRtc?: boolean;
  logger?: Logger;
}

/** Counters for application payloads, separated by direction and transport. */
export interface TrafficCount {
  messages: number;
  bytes: number;
}

export interface TrafficDirection {
  p2p: TrafficCount;
  mqtt: TrafficCount;
}

/** The local peer's subjective view: what it sent and what it received. */
export interface TrafficView {
  tx: TrafficDirection;
  rx: TrafficDirection;
}

export interface PeerStats {
  peerId: string;
  name: string;
  kind: PeerKind;
  version: string;
  route: PeerRoute;
  rttMs: number | null;
  p2pBytes: number;
  mqttBytes: number;
  p2pMessages: number;
  mqttMessages: number;
  p2pBytesPerSec: number;
  mqttBytesPerSec: number;
  /** Counters from this peer's own perspective. */
  traffic: TrafficView;
  /** Counters last reported by the remote peer in its presence message. */
  remoteTraffic: TrafficView | null;
  pings: number;
  roundTrips: number;
  lastPingAt: number | null;
  lastError: string | null;
}

export interface MeshTotals {
  peers: number;
  p2pBytes: number;
  mqttBytes: number;
  p2pMessages: number;
  mqttMessages: number;
  p2pBytesPerSec: number;
  mqttBytesPerSec: number;
  traffic: TrafficView;
}

export interface MeshSnapshot {
  self: { peerId: string; name: string; kind: PeerKind; version: string };
  brokerConnected: boolean;
  webRtcEnabled: boolean;
  peers: PeerStats[];
  totals: MeshTotals;
  recentIssues: MeshIssue[];
  updatedAt: number;
}

export interface MeshIssue {
  v: 2;
  type: "issue";
  id: string;
  peerId: string;
  name: string;
  kind: PeerKind;
  version: string;
  level: IssueLevel;
  message: string;
  context: Record<string, string | number | boolean>;
  ts: number;
}

export interface MeshPeer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getSnapshot(): MeshSnapshot;
  onSnapshot(listener: (snapshot: MeshSnapshot) => void): Unsubscribe;
  setWebRtcEnabled(enabled: boolean): void;
  resetStats(): void;
  /** Publishes a diagnostic issue on MQTT (and stores it locally). */
  reportIssue(
    level: IssueLevel,
    message: string,
    context?: Record<string, string | number | boolean>,
  ): void;
}

export interface RemotePeer {
  peerId: string;
  name: string;
  kind: PeerKind;
  version: string;
  identityId: string;
  identityPublicKey: JsonWebKey;
  lastSeen: number;
  traffic: TrafficView | null;
}

export interface PresenceMessage {
  v: 2;
  type: "presence" | "leave";
  peerId: string;
  name: string;
  kind: PeerKind;
  version: string;
  identityId: string;
  identityPublicKey: JsonWebKey;
  traffic?: TrafficView;
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
  version: string;
  route: PeerRoute;
  rttMs: number | null;
  p2pBytes: number;
  mqttBytes: number;
  p2pMessages: number;
  mqttMessages: number;
  p2pBytesPerSec: number;
  mqttBytesPerSec: number;
  traffic: TrafficView;
  remoteTraffic: TrafficView | null;
  pings: number;
  roundTrips: number;
  lastPingAt: number | null;
  lastError: string | null;
}
