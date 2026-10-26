import { P2PLinkError, P2PLinkErrorCodes, type ServerIdentityPin } from "@p2plink/core";
import { canonicalJson, fromBase64Url, sha256, toBase64Url, utf8Encode } from "./encoding.js";

/** Minimal public JWK fields that identify a P-256 key. */
export interface PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  [key: string]: unknown;
}

export interface IdentityKeyPair {
  identityId: string;
  publicKeyJwk: JsonWebKey;
  privateKey: CryptoKey;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

const ECDSA_PARAMS: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const ECDSA_SIGN: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };

export async function generateIdentity(
  identityId: string,
  options: { extractable?: boolean } = {},
): Promise<IdentityKeyPair> {
  if (!identityId) throw new P2PLinkError(P2PLinkErrorCodes.INVALID_CONFIG, "identityId is required");
  const keyPair = await globalThis.crypto.subtle.generateKey(ECDSA_PARAMS, options.extractable ?? false, [
    "sign",
    "verify",
  ]);
  const publicKeyJwk = await globalThis.crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return wrapIdentity(identityId, keyPair.privateKey, publicKeyJwk);
}

export async function importIdentity(input: {
  identityId: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk?: JsonWebKey;
  privateKey?: CryptoKey;
}): Promise<IdentityKeyPair> {
  let privateKey = input.privateKey;
  if (!privateKey) {
    if (!input.privateKeyJwk) {
      throw new P2PLinkError(
        P2PLinkErrorCodes.INVALID_CONFIG,
        "Either privateKey or privateKeyJwk is required",
      );
    }
    privateKey = await globalThis.crypto.subtle.importKey(
      "jwk",
      input.privateKeyJwk,
      ECDSA_PARAMS,
      false,
      ["sign"],
    );
  }
  validatePublicJwk(input.publicKeyJwk);
  return wrapIdentity(input.identityId, privateKey, input.publicKeyJwk);
}

export async function exportIdentity(identity: IdentityKeyPair): Promise<{
  identityId: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}> {
  if (!identity.privateKey.extractable) {
    throw new P2PLinkError(
      P2PLinkErrorCodes.INVALID_CONFIG,
      "Identity private key is not extractable; generate it with { extractable: true } if persistence is required",
    );
  }
  const privateKeyJwk = await globalThis.crypto.subtle.exportKey("jwk", identity.privateKey);
  return {
    identityId: identity.identityId,
    publicKeyJwk: identity.publicKeyJwk,
    privateKeyJwk,
  };
}

function wrapIdentity(
  identityId: string,
  privateKey: CryptoKey,
  publicKeyJwk: JsonWebKey,
): IdentityKeyPair {
  validatePublicJwk(publicKeyJwk);
  return {
    identityId,
    publicKeyJwk,
    privateKey,
    async sign(data: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(
        await globalThis.crypto.subtle.sign(ECDSA_SIGN, privateKey, data as BufferSource),
      );
    },
  };
}

export function validatePublicJwk(jwk: JsonWebKey): asserts jwk is PublicJwk {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Expected an EC P-256 public JWK");
  }
}

export function normalizePublicJwk(jwk: JsonWebKey): PublicJwk {
  validatePublicJwk(jwk);
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

export async function publicKeyFingerprint(jwk: JsonWebKey): Promise<string> {
  const canonical = canonicalJson(normalizePublicJwk(jwk));
  const digest = await sha256(utf8Encode(canonical));
  return `sha256:${toBase64Url(digest)}`;
}

export async function verifySignature(
  publicKeyJwk: JsonWebKey,
  data: Uint8Array,
  signature: Uint8Array | string,
): Promise<boolean> {
  const signatureBytes = typeof signature === "string" ? fromBase64Url(signature) : signature;
  try {
    const key = await globalThis.crypto.subtle.importKey(
      "jwk",
      normalizePublicJwk(publicKeyJwk),
      ECDSA_PARAMS,
      false,
      ["verify"],
    );
    return await globalThis.crypto.subtle.verify(
      ECDSA_SIGN,
      key,
      signatureBytes as BufferSource,
      data as BufferSource,
    );
  } catch {
    return false;
  }
}

export async function assertServerIdentity(
  publicKeyJwk: JsonWebKey,
  pin: ServerIdentityPin | undefined,
): Promise<void> {
  const fingerprint = await publicKeyFingerprint(publicKeyJwk);
  if (pin?.fingerprint && pin.fingerprint !== fingerprint) {
    throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "Server identity fingerprint mismatch");
  }
  if (pin?.publicKeyJwk) {
    const pinned = await publicKeyFingerprint(pin.publicKeyJwk);
    if (pinned !== fingerprint) {
      throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "Server public key mismatch");
    }
  }
}
