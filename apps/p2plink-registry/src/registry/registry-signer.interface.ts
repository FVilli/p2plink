export interface PeerCertificateInput {
  peerId: string;
  userId: string;
  publicKeyJwk: JsonWebKey;
  fingerprint: string;
  serial: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface SignedPeerCertificate {
  token: string;
  serial: string;
  expiresAt: Date;
}

export interface RegistrySigner {
  readonly kid: string;
  publicJwk(): JsonWebKey;
  signPeerCertificate(input: PeerCertificateInput): Promise<SignedPeerCertificate>;
  signRevocation(input: {
    peerId: string;
    serial: string;
    reason: string;
    revokedAt: Date;
  }): Promise<{ event: string; payload: unknown }>;
}

export const REGISTRY_SIGNER = Symbol("REGISTRY_SIGNER");
