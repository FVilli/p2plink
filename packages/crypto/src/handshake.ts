import {
  P2PLinkError,
  P2PLinkErrorCodes,
  canonicalJson,
  type JsonObject,
 
  type ServerIdentityPin,
  type TransportKind,
} from "@p2plink/core";
import {
  fromBase64Url,
  randomBytes,
  randomToken,
  sha256,
  sha256Base64Url,
  toBase64Url,
  utf8Encode,
} from "./encoding.js";
import {
  assertServerIdentity,
  normalizePublicJwk,
  publicKeyFingerprint,
  validatePublicJwk,
  verifySignature,
  type IdentityKeyPair,
} from "./identity.js";

export const HANDSHAKE_VERSION = 1;
const DOMAIN_CLIENT_HELLO = "p2plink/v1/handshake/client-hello\n";
const DOMAIN_SERVER_HELLO = "p2plink/v1/handshake/server-hello\n";
const DOMAIN_TRANSCRIPT = "p2plink/v1/transcript\n";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

export interface ClientHello {
  v: 1;
  kind: "client-hello";
  tenant: string;
  serverId: string;
  clientId: string;
  sessionId: string;
  identityId: string;
  identityPublicKey: JsonWebKey;
  ephemeralPublicKey: JsonWebKey;
  nonce: string;
  /** Short-lived, single-use capability issued over HTTPS bootstrap. */
  capability: string;
  issuedAt: number;
}

export interface SignedClientHello extends ClientHello {
  signature: string;
}

export interface ServerHello {
  v: 1;
  kind: "server-hello";
  tenant: string;
  serverId: string;
  clientId: string;
  sessionId: string;
  identityId: string;
  identityPublicKey: JsonWebKey;
  ephemeralPublicKey: JsonWebKey;
  clientHelloHash: string;
  nonce: string;
  issuedAt: number;
}

export interface SignedServerHello extends ServerHello {
  signature: string;
}

export interface DirectionalKeys {
  c2s: CryptoKey;
  s2c: CryptoKey;
}

export interface SessionKeys {
  mqtt: DirectionalKeys;
  webrtc: DirectionalKeys;
}

export interface DerivedSession {
  sessionId: string;
  keys: SessionKeys;
  transcriptHash: string;
}

export interface CapabilityBinding {
  clientId: string;
  subject?: string;
  identityFingerprint: string;
  expiresAt?: number;
  claims?: JsonObject;
}

export interface ClientHandshakeState {
  hello: SignedClientHello;
  ephemeralPrivateKey: CryptoKey;
  issuedAt: number;
}

export interface ServerHandshakeState {
  clientHello: SignedClientHello;
  clientHelloHash: string;
  clientEphemeralPublicKey: JsonWebKey;
  capability: CapabilityBinding;
  ephemeralPrivateKey?: CryptoKey;
  serverHello?: SignedServerHello;
  issuedAt: number;
}

export interface ClockOptions {
  now?: () => number;
  clockSkewMs?: number;
}

export async function createClientHello(input: {
  tenant: string;
  serverId: string;
  clientId: string;
  sessionId: string;
  capability: string;
  identity: Pick<IdentityKeyPair, "identityId" | "publicKeyJwk" | "sign">;
  nonce?: string;
  now?: () => number;
}): Promise<ClientHandshakeState> {
  assertSessionId(input.sessionId);
  const keyPair = (await globalThis.crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const ephemeralPublicKey = await globalThis.crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const hello: ClientHello = {
    v: HANDSHAKE_VERSION,
    kind: "client-hello",
    tenant: input.tenant,
    serverId: input.serverId,
    clientId: input.clientId,
    sessionId: input.sessionId,
    identityId: input.identity.identityId,
    identityPublicKey: normalizePublicJwk(input.identity.publicKeyJwk),
    ephemeralPublicKey: normalizePublicJwk(ephemeralPublicKey),
    nonce: input.nonce ?? randomToken(32),
    capability: input.capability,
    issuedAt: (input.now ?? Date.now)(),
  };
  const signature = await input.identity.sign(
    utf8Encode(DOMAIN_CLIENT_HELLO + canonicalJson(hello)),
  );
  const signed: SignedClientHello = { ...hello, signature: toBase64Url(signature) };
  return {
    hello: signed,
    ephemeralPrivateKey: keyPair.privateKey,
    issuedAt: hello.issuedAt,
  };
}

export async function verifyClientHello(
  value: unknown,
  options: {
    tenant: string;
    serverId: string;
    validateCapability: (capability: string, hello: ClientHello) => Promise<CapabilityBinding>;
    clockSkewMs?: number;
    now?: () => number;
  },
): Promise<ServerHandshakeState> {
  assertClientHello(value);
  const hello = value;
  if (hello.tenant !== options.tenant || hello.serverId !== options.serverId) {
    throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "Client hello targets another server");
  }
  const now = (options.now ?? Date.now)();
  const skew = options.clockSkewMs ?? 120_000;
  if (Math.abs(now - hello.issuedAt) > skew) {
    throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "Client hello is expired");
  }
  const signature = fromBase64Url(hello.signature);
  const signedPayload: ClientHello = { ...hello };
  delete (signedPayload as Partial<SignedClientHello>).signature;
  const valid = await verifySignature(
    hello.identityPublicKey,
    utf8Encode(DOMAIN_CLIENT_HELLO + canonicalJson(signedPayload)),
    signature,
  );
  if (!valid) {
    throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "Invalid client hello signature");
  }
  const capability = await options.validateCapability(hello.capability, hello);
  const boundFingerprint = await publicKeyFingerprint(hello.identityPublicKey);
  if (
    capability.clientId !== hello.clientId ||
    capability.identityFingerprint !== boundFingerprint
  ) {
    throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "Capability identity mismatch");
  }
  if (capability.expiresAt !== undefined && capability.expiresAt < now) {
    throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "Capability expired");
  }
  return {
    clientHello: hello,
    clientHelloHash: await sha256Base64Url(utf8Encode(canonicalJson(hello))),
    clientEphemeralPublicKey: hello.ephemeralPublicKey,
    capability,
    issuedAt: now,
  };
}

export async function createServerHello(
  state: ServerHandshakeState,
  identity: Pick<IdentityKeyPair, "identityId" | "publicKeyJwk" | "sign">,
  options: { now?: () => number } = {},
): Promise<{ hello: SignedServerHello; state: ServerHandshakeState }> {
  const keyPair = (await globalThis.crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const ephemeralPublicKey = await globalThis.crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const hello: ServerHello = {
    v: HANDSHAKE_VERSION,
    kind: "server-hello",
    tenant: state.clientHello.tenant,
    serverId: state.clientHello.serverId,
    clientId: state.clientHello.clientId,
    sessionId: state.clientHello.sessionId,
    identityId: identity.identityId,
    identityPublicKey: normalizePublicJwk(identity.publicKeyJwk),
    ephemeralPublicKey: normalizePublicJwk(ephemeralPublicKey),
    clientHelloHash: state.clientHelloHash,
    nonce: randomToken(32),
    issuedAt: (options.now ?? Date.now)(),
  };
  const signature = await identity.sign(
    utf8Encode(DOMAIN_SERVER_HELLO + canonicalJson(hello)),
  );
  const signed: SignedServerHello = { ...hello, signature: toBase64Url(signature) };
  return {
    hello: signed,
    state: { ...state, ephemeralPrivateKey: keyPair.privateKey, serverHello: signed },
  };
}

export async function completeClientHandshake(
  state: ClientHandshakeState,
  value: unknown,
  options: {
    serverIdentityPin?: ServerIdentityPin;
    clockSkewMs?: number;
    now?: () => number;
  } = {},
): Promise<DerivedSession> {
  assertServerHello(value);
  const hello = value;
  const expected = state.hello;
  if (
    hello.tenant !== expected.tenant ||
    hello.serverId !== expected.serverId ||
    hello.clientId !== expected.clientId ||
    hello.sessionId !== expected.sessionId
  ) {
    throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "Server hello does not match session");
  }
  const expectedHash = await sha256Base64Url(utf8Encode(canonicalJson(expected)));
  if (hello.clientHelloHash !== expectedHash) {
    throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "Server hello transcript mismatch");
  }
  const now = (options.now ?? Date.now)();
  const skew = options.clockSkewMs ?? 120_000;
  if (Math.abs(now - hello.issuedAt) > skew) {
    throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "Server hello is expired");
  }
  await assertServerIdentity(hello.identityPublicKey, options.serverIdentityPin);
  const signature = fromBase64Url(hello.signature);
  const signedPayload: ServerHello = { ...hello };
  delete (signedPayload as Partial<SignedServerHello>).signature;
  const valid = await verifySignature(
    hello.identityPublicKey,
    utf8Encode(DOMAIN_SERVER_HELLO + canonicalJson(signedPayload)),
    signature,
  );
  if (!valid) {
    throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "Invalid server hello signature");
  }
  const serverEphemeralKey = await globalThis.crypto.subtle.importKey(
    "jwk",
    normalizePublicJwk(hello.ephemeralPublicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await globalThis.crypto.subtle.deriveBits(
      { name: "ECDH", public: serverEphemeralKey },
      state.ephemeralPrivateKey,
      256,
    ),
  );
  return deriveSession(expected, hello, shared);
}

export async function completeServerHandshake(state: ServerHandshakeState): Promise<DerivedSession> {
  if (!state.ephemeralPrivateKey || !state.serverHello) {
    throw new P2PLinkError(P2PLinkErrorCodes.INVALID_CONFIG, "Server hello has not been created");
  }
  const clientEphemeralKey = await globalThis.crypto.subtle.importKey(
    "jwk",
    normalizePublicJwk(state.clientEphemeralPublicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await globalThis.crypto.subtle.deriveBits(
      { name: "ECDH", public: clientEphemeralKey },
      state.ephemeralPrivateKey,
      256,
    ),
  );
  return deriveSession(state.clientHello, state.serverHello, shared);
}

async function deriveSession(
  clientHello: SignedClientHello,
  serverHello: SignedServerHello,
  shared: Uint8Array,
): Promise<DerivedSession> {
  const transcript = utf8Encode(
    DOMAIN_TRANSCRIPT + canonicalJson({ clientHello, serverHello }),
  );
  const salt = await sha256(transcript);
  const baseKey = await globalThis.crypto.subtle.importKey("raw", shared as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const keys: SessionKeys = {
    mqtt: await deriveDirectionalKeys(baseKey, salt, clientHello.sessionId, "mqtt"),
    webrtc: await deriveDirectionalKeys(baseKey, salt, clientHello.sessionId, "webrtc"),
  };
  return {
    sessionId: clientHello.sessionId,
    keys,
    transcriptHash: toBase64Url(salt),
  };
}

async function deriveDirectionalKeys(
  baseKey: CryptoKey,
  salt: Uint8Array,
  sessionId: string,
  transport: TransportKind,
): Promise<DirectionalKeys> {
  return {
    c2s: await deriveAesKey(baseKey, salt, `p2plink/v1/${transport}/${sessionId}/c2s`),
    s2c: await deriveAesKey(baseKey, salt, `p2plink/v1/${transport}/${sessionId}/s2c`),
  };
}

async function deriveAesKey(
  baseKey: CryptoKey,
  salt: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: utf8Encode(info) as BufferSource,
    },
    baseKey,
    256,
  );
  return globalThis.crypto.subtle.importKey("raw", bits, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new P2PLinkError(P2PLinkErrorCodes.INVALID_CONFIG, "Invalid session id");
  }
}

function isShortString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function assertBaseHello(value: unknown): asserts value is ClientHello | ServerHello {
  if (typeof value !== "object" || value === null) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Handshake message must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.v !== HANDSHAKE_VERSION) {
    throw new P2PLinkError(P2PLinkErrorCodes.UNSUPPORTED_VERSION, "Unsupported handshake version");
  }
  if (record.kind !== "client-hello" && record.kind !== "server-hello") {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Unknown handshake kind");
  }
  for (const field of ["tenant", "serverId", "clientId", "sessionId", "identityId"] as const) {
    if (!isShortString(record[field], 1, 64)) {
      throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, `Invalid handshake field: ${field}`);
    }
  }
  if (!SESSION_ID_PATTERN.test(record.sessionId as string)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid session id in handshake");
  }
  validatePublicJwk(record.identityPublicKey as JsonWebKey);
  validatePublicJwk(record.ephemeralPublicKey as JsonWebKey);
  if (!isShortString(record.nonce, 16, 256)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid handshake nonce");
  }
  if (typeof record.issuedAt !== "number" || !Number.isFinite(record.issuedAt)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid handshake timestamp");
  }
  if (!isShortString(record.signature, 64, 128)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid handshake signature");
  }
  try {
    fromBase64Url(record.signature);
  } catch {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid handshake signature encoding");
  }
}

export function assertClientHello(value: unknown): asserts value is SignedClientHello {
  assertBaseHello(value);
  const record = value as unknown as Record<string, unknown>;
  if (record.kind !== "client-hello") {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Expected client hello");
  }
  if (!isShortString(record.capability, 32, 16 * 1024)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid bootstrap capability");
  }
}

export function assertServerHello(value: unknown): asserts value is SignedServerHello {
  assertBaseHello(value);
  const record = value as unknown as Record<string, unknown>;
  if (record.kind !== "server-hello") {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Expected server hello");
  }
  if (!isShortString(record.clientHelloHash, 16, 128)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid client hello hash");
  }
}
