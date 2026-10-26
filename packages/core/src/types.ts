/** A function that removes a listener or subscription. */
export type Unsubscribe = () => void;

export type MaybePromise<T> = T | Promise<T>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface RpcDefinition {
  request: unknown;
  response: unknown;
}

/** Application RPC contract: method name -> request/response types. */
export type RpcContract = Record<string, RpcDefinition>;

/** Application push-event contract: event name -> payload type. */
export type EventContract = Record<string, unknown>;

/**
 * Argument tuple for an RPC method. Methods whose request type is `void` or
 * `undefined` can be called without an argument.
 */
export type RequestArgs<C extends RpcContract, K extends keyof C & string> =
  C[K]["request"] extends void | undefined ? [] : [request: C[K]["request"]];

export type TransportKind = "mqtt" | "webrtc";

export type TransportState = "connecting" | "open" | "closed" | "failed";

export type ConnectionStatus =
  | "connecting"
  | "p2p"
  | "mqtt"
  | "offline"
  | "reconnecting"
  | "closed";

export interface SerializedError {
  code: string;
  message: string;
  retryable: boolean;
  outcomeUnknown: boolean;
  details?: JsonValue;
}

export interface ConnectionSnapshot {
  status: ConnectionStatus;
  /** Transport currently used for application traffic. */
  transport: TransportKind | null;
  sessionId: string | null;
  clientId: string | null;
  serverId: string;
  rttMs: number | null;
  rttByTransport: Partial<Record<TransportKind, number>>;
  lastError: SerializedError | null;
  /** Epoch ms of the last successful session establishment. */
  connectedAt: number | null;
  pendingRequests: number;
  /** Epoch ms of the last status transition. */
  since: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface HeartbeatLimits {
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  /** Time a WebRTC transport must stay open and responsive before promotion. */
  promoteAfterMs: number;
  /** Cooldown after a WebRTC demotion to avoid transport flapping. */
  switchCooldownMs: number;
  maxPendingPings: number;
}

export interface P2PLinkLimits extends HeartbeatLimits {
  maxPayloadBytes: number;
  maxFrameBytes: number;
  maxPendingRequests: number;
  requestTimeoutMs: number;
  handshakeTimeoutMs: number;
  sessionIdleTimeoutMs: number;
  maxSessions: number;
  maxHandshakes: number;
  rateLimitPerSecond: number;
  maxQueuedBytes: number;
}

export const DEFAULT_LIMITS: P2PLinkLimits = {
  heartbeatIntervalMs: 5_000,
  heartbeatTimeoutMs: 15_000,
  promoteAfterMs: 3_000,
  switchCooldownMs: 5_000,
  maxPendingPings: 8,
  maxPayloadBytes: 64 * 1024,
  maxFrameBytes: 256 * 1024,
  maxPendingRequests: 64,
  requestTimeoutMs: 15_000,
  handshakeTimeoutMs: 10_000,
  sessionIdleTimeoutMs: 120_000,
  maxSessions: 500,
  maxHandshakes: 50,
  rateLimitPerSecond: 50,
  maxQueuedBytes: 8 * 1024 * 1024,
};

export interface ClientIdentity {
  identityId: string;
  publicKeyJwk: JsonWebKey;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export interface ServerIdentity extends ClientIdentity {}

export interface ServerIdentityPin {
  publicKeyJwk?: JsonWebKey;
  /** `sha256:<base64url>` fingerprint of the canonical public JWK. */
  fingerprint?: string;
}

export interface MqttCredentials {
  url?: string;
  username?: string;
  password?: string;
  clientId?: string;
}

export interface BootstrapRequest {
  protocolVersion: 1;
  clientId: string;
  tenant: string;
  serverId: string;
  identityId: string;
  identityPublicKey: JsonWebKey;
  /** Optional client-generated id; servers must treat it as untrusted. */
  requestId: string;
}

export interface BootstrapResult {
  /** Short-lived, single-use, identity-bound capability (opaque). */
  capability: string;
  clientId: string;
  expiresAt: number;
  mqtt?: MqttCredentials;
  server: {
    identityId: string;
    publicKeyJwk: JsonWebKey;
  };
}

export interface BootstrapProvider {
  bootstrap(request: BootstrapRequest): Promise<BootstrapResult>;
}

export interface RequestOptions {
  timeoutMs?: number;
  /** Safe to replay on another transport. Defaults to false. */
  idempotent?: boolean;
  /** Stable key for server-side deduplication. Defaults to the request id. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}
