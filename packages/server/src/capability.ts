import {
  P2PLinkError,
  P2PLinkErrorCodes,
  canonicalJson,
  fromBase64Url,
  randomToken,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type JsonObject,
  type ServerIdentity,
} from "@p2plink/core";
import { publicKeyFingerprint, verifySignature } from "@p2plink/crypto";

export const CAPABILITY_VERSION = 1;
export const CAPABILITY_TYPE = "p2plink-cap";
const MAX_CAPABILITY_BYTES = 16 * 1024;

export interface CapabilityClaims {
  v: 1;
  typ: typeof CAPABILITY_TYPE;
  sub: string;
  clientId: string;
  tenant: string;
  serverId: string;
  identityFingerprint: string;
  nonce: string;
  iat: number;
  exp: number;
  claims?: JsonObject;
}

export interface IssueCapabilityInput {
  subject: string;
  clientId: string;
  tenant: string;
  serverId: string;
  identityFingerprint: string;
  ttlMs: number;
  claims?: JsonObject;
  now?: () => number;
}

export interface CapabilityStore {
  /** Atomically marks a nonce as used. Returns false if it was already used. */
  consume(nonce: string, expiresAt: number): Promise<boolean>;
}

/** Single-process capability replay cache. Use a shared store for replicas. */
export class MemoryCapabilityStore implements CapabilityStore {
  private readonly used = new Map<string, number>();

  async consume(nonce: string, expiresAt: number): Promise<boolean> {
    const now = Date.now();
    const existing = this.used.get(nonce);
    if (existing !== undefined && existing > now) return false;
    this.used.set(nonce, expiresAt);
    if (this.used.size > 20_000) this.prune(now);
    return true;
  }

  private prune(now: number): void {
    for (const [nonce, expiresAt] of this.used) {
      if (expiresAt <= now) this.used.delete(nonce);
    }
  }
}

export async function issueCapability(
  identity: ServerIdentity,
  input: IssueCapabilityInput,
): Promise<{ capability: string; claims: CapabilityClaims }> {
  const now = (input.now ?? Date.now)();
  const claims: CapabilityClaims = {
    v: CAPABILITY_VERSION,
    typ: CAPABILITY_TYPE,
    sub: input.subject,
    clientId: input.clientId,
    tenant: input.tenant,
    serverId: input.serverId,
    identityFingerprint: input.identityFingerprint,
    nonce: randomToken(24),
    iat: now,
    exp: now + input.ttlMs,
    ...(input.claims === undefined ? {} : { claims: input.claims }),
  };
  const kid = await publicKeyFingerprint(identity.publicKeyJwk);
  const header = toBase64Url(
    utf8Encode(canonicalJson({ alg: "ES256", typ: CAPABILITY_TYPE, kid })),
  );
  const payload = toBase64Url(utf8Encode(canonicalJson(claims)));
  const signingInput = `${header}.${payload}`;
  const signature = await identity.sign(utf8Encode(signingInput));
  return { capability: `${signingInput}.${toBase64Url(signature)}`, claims };
}

export async function verifyCapability(
  capability: string,
  expected: { publicKeyJwk: JsonWebKey; tenant: string; serverId: string },
  options: { now?: () => number; clockSkewMs?: number } = {},
): Promise<CapabilityClaims> {
  if (capability.length > MAX_CAPABILITY_BYTES) {
    throw new P2PLinkError(P2PLinkErrorCodes.CAPABILITY_INVALID, "Capability is too large");
  }
  const parts = capability.split(".");
  if (parts.length !== 3) {
    throw new P2PLinkError(P2PLinkErrorCodes.CAPABILITY_INVALID, "Malformed capability");
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: unknown;
  let claims: unknown;
  try {
    header = JSON.parse(utf8Decode(fromBase64Url(headerPart))) as unknown;
    claims = JSON.parse(utf8Decode(fromBase64Url(payloadPart))) as unknown;
  } catch {
    throw new P2PLinkError(P2PLinkErrorCodes.CAPABILITY_INVALID, "Malformed capability");
  }
  if (
    typeof header !== "object" ||
    header === null ||
    (header as { alg?: unknown }).alg !== "ES256" ||
    (header as { typ?: unknown }).typ !== CAPABILITY_TYPE
  ) {
    throw new P2PLinkError(P2PLinkErrorCodes.CAPABILITY_INVALID, "Invalid capability header");
  }
  const parsed = assertClaims(claims);
  const now = (options.now ?? Date.now)();
  const skew = options.clockSkewMs ?? 30_000;
  if (parsed.exp + skew < now || parsed.iat - skew > now) {
    throw new P2PLinkError(P2PLinkErrorCodes.CAPABILITY_INVALID, "Capability expired");
  }
  if (parsed.tenant !== expected.tenant || parsed.serverId !== expected.serverId) {
    throw new P2PLinkError(P2PLinkErrorCodes.CAPABILITY_INVALID, "Capability target mismatch");
  }
  const valid = await verifySignature(
    expected.publicKeyJwk,
    utf8Encode(`${headerPart}.${payloadPart}`),
    fromBase64Url(signaturePart),
  );
  if (!valid) {
    throw new P2PLinkError(P2PLinkErrorCodes.CAPABILITY_INVALID, "Invalid capability signature");
  }
  return parsed;
}

function assertClaims(value: unknown): CapabilityClaims {
  if (typeof value !== "object" || value === null) {
    throw new P2PLinkError(P2PLinkErrorCodes.CAPABILITY_INVALID, "Invalid capability claims");
  }
  const record = value as Record<string, unknown>;
  if (
    record.v !== CAPABILITY_VERSION ||
    record.typ !== CAPABILITY_TYPE ||
    typeof record.sub !== "string" ||
    typeof record.clientId !== "string" ||
    typeof record.tenant !== "string" ||
    typeof record.serverId !== "string" ||
    typeof record.identityFingerprint !== "string" ||
    typeof record.nonce !== "string" ||
    typeof record.iat !== "number" ||
    typeof record.exp !== "number"
  ) {
    throw new P2PLinkError(P2PLinkErrorCodes.CAPABILITY_INVALID, "Invalid capability claims");
  }
  return value as CapabilityClaims;
}
