import type {
  BootstrapProvider,
  ClientIdentity,
  IceServer,
  JsonObject,
  Logger,
  P2PLinkLimits,
  ServerIdentityPin,
} from "@p2plink/core";
import type { WebRtcEngine } from "@p2plink/webrtc";

export interface ClientMqttConfig {
  /** Explicit broker URL; the bootstrap response may provide one instead. */
  url?: string;
  username?: string;
  password?: string;
  /** MQTT client id; not the P2PLink identity. */
  clientId?: string;
  credentials?: () => Promise<{ url?: string; username?: string; password?: string }>;
  keepaliveSeconds?: number;
  reconnectPeriodMs?: number;
  connectTimeoutMs?: number;
  maxPayloadBytes?: number;
}

export interface ClientWebRtcConfig {
  /** Defaults to true. When false, MQTT is the only transport. */
  enabled?: boolean;
  /** No implicit public STUN is used; configure this explicitly. */
  iceServers?: IceServer[];
  engine?: WebRtcEngine;
  chunkSize?: number;
  maxQueuedBytes?: number;
  reconnect?: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    maxAttempts?: number;
    jitter?: number;
  };
}

export interface ClientSecurityConfig {
  identity?: ClientIdentity | (() => Promise<ClientIdentity>);
  /** Extra out-of-band pin checked against the bootstrap server key. */
  serverIdentity?: ServerIdentityPin;
  clockSkewMs?: number;
  /** Required to call an http:// bootstrap URL (development only). */
  allowInsecureBootstrap?: boolean;
}

export interface P2PLinkClientConfig {
  serverId: string;
  tenant?: string;
  /** Requested client id; the bootstrap server may assign another one. */
  clientId?: string;
  bootstrap: BootstrapProvider;
  mqtt?: ClientMqttConfig;
  webrtc?: ClientWebRtcConfig;
  security?: ClientSecurityConfig;
  limits?: Partial<P2PLinkLimits>;
  logger?: Logger;
  /** Optional metadata forwarded to the bootstrap provider by custom implementations. */
  metadata?: JsonObject;
}
