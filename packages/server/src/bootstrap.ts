import {
  P2PLinkError,
  P2PLinkErrorCodes,
  TokenBucket,
  isPlainObject,
  type BootstrapRequest,
  type BootstrapResult,
  type JsonObject,
  type MqttCredentials,
  type ServerIdentity,
} from "@p2plink/core";
import { publicKeyFingerprint, validatePublicJwk } from "@p2plink/crypto";
import {
  MemoryCapabilityStore,
  issueCapability,
  type CapabilityClaims,
  type CapabilityStore,
} from "./capability.js";

export interface BootstrapAuthenticationContext {
  authorization: string | null;
  request: BootstrapRequest;
  ip?: string;
}

export interface BootstrapAuthentication {
  subject: string;
  /** Optional server-assigned client id; defaults to the requested one. */
  clientId?: string;
  claims?: JsonObject;
}

export interface BootstrapAuthenticator {
  authenticate(context: BootstrapAuthenticationContext): Promise<BootstrapAuthentication>;
}

export interface MqttCredentialsContext {
  subject: string;
  clientId: string;
  identityFingerprint: string;
  expiresAt: number;
  claims?: JsonObject;
}

export type MqttCredentialsIssuer = (
  context: MqttCredentialsContext,
) => Promise<MqttCredentials | undefined>;

export interface BootstrapOptions {
  authenticator: BootstrapAuthenticator;
  mqttCredentials?: MqttCredentialsIssuer;
  capabilityStore?: CapabilityStore;
  capabilityTtlMs?: number;
  maxRequestsPerMinute?: number;
}

export interface BootstrapHttpRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  ip?: string;
}

export interface BootstrapHttpResponse {
  status: number;
  body: unknown;
}

export class BootstrapService {
  private readonly options: BootstrapOptions;
  private readonly store: CapabilityStore;
  private readonly limiters = new Map<string, { bucket: TokenBucket; seenAt: number }>();

  constructor(
    private readonly config: {
      serverId: string;
      tenant: string;
      identity: ServerIdentity;
    },
    options: BootstrapOptions,
  ) {
    this.options = options;
    this.store = options.capabilityStore ?? new MemoryCapabilityStore();
  }

  get capabilityStore(): CapabilityStore {
    return this.store;
  }

  async handle(request: BootstrapHttpRequest): Promise<BootstrapHttpResponse> {
    try {
      if (request.method.toUpperCase() !== "POST") {
        return { status: 405, body: { error: "Method not allowed" } };
      }
      const authorization = headerValue(request.headers, "authorization") ?? null;
      const bootstrapRequest = parseBootstrapRequest(request.body);
      if (
        bootstrapRequest.serverId !== this.config.serverId ||
        bootstrapRequest.tenant !== this.config.tenant
      ) {
        return { status: 400, body: { error: "Target mismatch" } };
      }
      const rateKey = authorization ? hashKey(authorization) : (request.ip ?? "unknown");
      if (!this.allowRequest(rateKey)) {
        return { status: 429, body: { error: "Too many bootstrap requests" } };
      }
      const authentication = await this.options.authenticator.authenticate({
        authorization,
        request: bootstrapRequest,
        ...(request.ip === undefined ? {} : { ip: request.ip }),
      });
      if (!authentication.subject) {
        throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "Invalid bootstrap identity");
      }
      const clientId = authentication.clientId ?? bootstrapRequest.clientId;
      if (!/^[A-Za-z0-9._-]{1,64}$/u.test(clientId)) {
        throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "Invalid client id");
      }
      validatePublicJwk(bootstrapRequest.identityPublicKey);
      const identityFingerprint = await publicKeyFingerprint(bootstrapRequest.identityPublicKey);
      const ttlMs = this.options.capabilityTtlMs ?? 60_000;
      const { capability, claims } = await issueCapability(this.config.identity, {
        subject: authentication.subject,
        clientId,
        tenant: this.config.tenant,
        serverId: this.config.serverId,
        identityFingerprint,
        ttlMs,
        ...(authentication.claims === undefined ? {} : { claims: authentication.claims }),
      });
      const mqtt = this.options.mqttCredentials
        ? await this.options.mqttCredentials({
            subject: authentication.subject,
            clientId,
            identityFingerprint,
            expiresAt: claims.exp,
            ...(authentication.claims === undefined ? {} : { claims: authentication.claims }),
          })
        : undefined;
      const result: BootstrapResult = {
        capability,
        clientId,
        expiresAt: claims.exp,
        server: {
          identityId: this.config.identity.identityId,
          publicKeyJwk: this.config.identity.publicKeyJwk,
        },
        ...(mqtt === undefined ? {} : { mqtt }),
      };
      return { status: 200, body: result };
    } catch (error) {
      const normalized = P2PLinkError.from(error);
      const status =
        normalized.code === P2PLinkErrorCodes.AUTH_FAILED
          ? 401
          : normalized.code === P2PLinkErrorCodes.FORBIDDEN
            ? 403
            : normalized.code === P2PLinkErrorCodes.RATE_LIMITED
              ? 429
              : 400;
      return {
        status,
        body: { error: status === 401 ? "Unauthorized" : normalized.message },
      };
    }
  }

  private allowRequest(key: string): boolean {
    const now = Date.now();
    let entry = this.limiters.get(key);
    if (!entry || now - entry.seenAt > 5 * 60_000) {
      entry = {
        bucket: new TokenBucket({
          capacity: this.options.maxRequestsPerMinute ?? 10,
          refillPerSecond: (this.options.maxRequestsPerMinute ?? 10) / 60,
        }),
        seenAt: now,
      };
      this.limiters.set(key, entry);
    }
    entry.seenAt = now;
    if (this.limiters.size > 10_000) this.limiters.clear();
    return entry.bucket.tryRemove();
  }
}

export function parseBootstrapRequest(value: unknown): BootstrapRequest {
  if (!isPlainObject(value)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed bootstrap request");
  }
  const record = value as Record<string, unknown>;
  if (
    record.protocolVersion !== 1 ||
    typeof record.clientId !== "string" ||
    typeof record.tenant !== "string" ||
    typeof record.serverId !== "string" ||
    typeof record.identityId !== "string" ||
    typeof record.requestId !== "string"
  ) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed bootstrap request");
  }
  validatePublicJwk(record.identityPublicKey as JsonWebKey);
  return value as unknown as BootstrapRequest;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function hashKey(value: string): string {
  // Not a secret; only used as a rate-limit bucket key.
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return String(hash);
}

export type { CapabilityStore, CapabilityClaims };
