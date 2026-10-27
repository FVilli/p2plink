import { importJWK, jwtVerify, type JWK, type JWTVerifyResult } from "jose";
import { publicKeyFingerprint, validatePublicJwk } from "@p2plink/crypto";

export interface PeerCertificateClaims {
  iss: string;
  aud: string;
  sub: string;
  userId: string;
  jwk: JsonWebKey;
  fingerprint: string;
  serial: string;
  iat: number;
  nbf: number;
  exp: number;
}

/** Verifies a registry-signed peer certificate with a previously trusted registry key. */
export async function verifyPeerCertificate(
  token: string,
  registryPublicJwk: JsonWebKey,
  options: {
    issuer?: string;
    audience?: string;
    now?: number;
    expectedPeerId?: string;
    expectedFingerprint?: string;
    revokedSerials?: ReadonlySet<string>;
  } = {},
): Promise<JWTVerifyResult & { payload: PeerCertificateClaims }> {
  const key = await importJWK(registryPublicJwk as JWK, "ES256");
  const result = await jwtVerify(token, key, {
    algorithms: ["ES256"],
    issuer: options.issuer ?? "p2plink-registry",
    audience: options.audience ?? "p2plink-peer",
    ...(options.now === undefined ? {} : { currentDate: new Date(options.now) }),
  });
  if (result.protectedHeader.typ !== "p2plink-peer-cert") {
    throw new Error("Invalid peer certificate type");
  }
  const payload = result.payload as Partial<PeerCertificateClaims>;
  if (
    payload.iss !== "p2plink-registry" ||
    payload.aud !== "p2plink-peer" ||
    typeof payload.sub !== "string" ||
    typeof payload.userId !== "string" ||
    typeof payload.fingerprint !== "string" ||
    typeof payload.serial !== "string" ||
    typeof payload.jwk !== "object" ||
    payload.jwk === null
  ) {
    throw new Error("Invalid peer certificate claims");
  }
  try {
    validatePublicJwk(payload.jwk as JsonWebKey);
  } catch {
    throw new Error("Invalid peer certificate key");
  }
  const expectedFingerprint = await publicKeyFingerprint(payload.jwk as JsonWebKey);
  if (payload.fingerprint !== expectedFingerprint) {
    throw new Error("Peer certificate fingerprint mismatch");
  }
  if (options.expectedPeerId !== undefined && payload.sub !== options.expectedPeerId) {
    throw new Error("Peer certificate peerId mismatch");
  }
  if (
    options.expectedFingerprint !== undefined &&
    payload.fingerprint !== options.expectedFingerprint
  ) {
    throw new Error("Peer certificate fingerprint mismatch");
  }
  if (options.revokedSerials?.has(payload.serial)) {
    throw new Error("Peer certificate revoked");
  }
  return result as JWTVerifyResult & { payload: PeerCertificateClaims };
}
