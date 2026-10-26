import { P2PLinkError, P2PLinkErrorCodes } from "./errors.js";

export const PROTOCOL_TOPIC_VERSION = "v1";
export const DEFAULT_TENANT = "default";

const SAFE_PART = /^[A-Za-z0-9._-]{1,64}$/u;

export function assertTopicPart(name: string, value: string): string {
  if (!SAFE_PART.test(value)) {
    throw new P2PLinkError(
      P2PLinkErrorCodes.INVALID_CONFIG,
      `Invalid ${name}: expected 1-64 chars from [A-Za-z0-9._-]`,
      { details: { name, value } },
    );
  }
  return value;
}

export interface TopicParts {
  tenant: string;
  serverId: string;
  clientId: string;
}

export interface SessionTopics {
  /** Client -> server session traffic (handshake + encrypted frames). */
  sessionC2s: string;
  /** Server -> client session traffic. */
  sessionS2c: string;
  /** Server -> client unencrypted control (session-reset only, no secrets). */
  signalS2c: string;
}

function base(tenant: string, serverId: string): string {
  return `p2plink/${PROTOCOL_TOPIC_VERSION}/${assertTopicPart("tenant", tenant)}/${assertTopicPart(
    "serverId",
    serverId,
  )}`;
}

export function sessionTopics(parts: TopicParts): SessionTopics {
  const prefix = base(parts.tenant, parts.serverId);
  const clientId = assertTopicPart("clientId", parts.clientId);
  return {
    sessionC2s: `${prefix}/session/${clientId}/c2s`,
    sessionS2c: `${prefix}/session/${clientId}/s2c`,
    signalS2c: `${prefix}/signal/${clientId}/s2c`,
  };
}

/** Wildcard used by the server to receive session traffic from all clients. */
export function serverSessionSubscription(tenant: string, serverId: string): string {
  return `${base(tenant, serverId)}/session/+/c2s`;
}

/** Exact wildcard subscription used by the server for client session ids. */
export function sessionClientIdFromTopic(topic: string): string | null {
  const match = /^p2plink\/v1\/[^/]+\/[^/]+\/session\/([^/]+)\/c2s$/u.exec(topic);
  if (!match) return null;
  return match[1] ?? null;
}
