import {
  exportIdentity,
  generateIdentity,
  importIdentity,
  toBase64Url,
  type IdentityKeyPair,
} from "@p2plink/crypto";

export const DEFAULT_REGISTRY_URL = "https://p2plink-registry.fvsg.mqu.it";
export const REGISTRY_IDENTITY_KEY = "p2plink-registry-identity";
export const REGISTRY_PEER_KEY = "p2plink-registry-peer";

export interface RegistryTokens {
  accessToken: string;
  refreshToken: string;
}

export interface RegistryMqtt {
  url: string;
  username: string;
  password: string;
  clientId: string;
}

export interface RegistryPeer {
  peer: { peerId: string; name: string; status: string };
  mqtt: RegistryMqtt;
  certificate: string;
}

export interface StoredIdentity {
  identityId: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const json = async <T>(response: Response): Promise<T> => {
  const body = (await response.json().catch(() => ({}))) as { message?: unknown };
  if (!response.ok) {
    throw new Error(typeof body.message === "string" ? body.message : `HTTP ${response.status}`);
  }
  return body as T;
};

export class RegistryApi {
  readonly baseUrl: string;

  constructor(baseUrl = DEFAULT_REGISTRY_URL) {
    this.baseUrl = baseUrl.replace(/\/$/u, "");
  }

  private async call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (token) headers.set("authorization", `Bearer ${token}`);
    return json<T>(await fetch(`${this.baseUrl}${path}`, { ...init, headers }));
  }

  register(email: string, password: string): Promise<{ ok: true }> {
    return this.call("/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }

  resendVerification(email: string): Promise<{ ok: true }> {
    return this.call("/v1/auth/resend-verification", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  }

  verifyEmail(email: string, token: string): Promise<RegistryTokens> {
    return this.call("/v1/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ email, token }),
    });
  }

  login(email: string, password: string): Promise<RegistryTokens> {
    return this.call("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: email, password }),
    });
  }

  refresh(refreshToken: string): Promise<RegistryTokens> {
    return this.call("/v1/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
  }

  logout(refreshToken: string, peerId?: string): Promise<{ ok: true }> {
    return this.call("/v1/auth/logout", {
      method: "POST",
      body: JSON.stringify({ refreshToken, ...(peerId ? { peerId } : {}) }),
    });
  }

  forgotPassword(email: string): Promise<{ ok: true }> {
    return this.call("/v1/auth/password/forgot", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  }

  resetPassword(email: string, token: string, newPassword: string): Promise<{ ok: true }> {
    return this.call("/v1/auth/password/reset", {
      method: "POST",
      body: JSON.stringify({ email, token, newPassword }),
    });
  }

  challenge(
    accessToken: string,
    purpose: "REGISTER" | "CREDENTIALS",
    publicKeyJwk?: JsonWebKey,
    peerId?: string,
  ): Promise<{ challengeId: string; nonce: string; expiresAt: string }> {
    return this.call(
      "/v1/peers/challenge",
      {
        method: "POST",
        body: JSON.stringify({
          purpose,
          ...(publicKeyJwk ? { publicKeyJwk } : {}),
          ...(peerId ? { peerId } : {}),
        }),
      },
      accessToken,
    );
  }

  registerPeer(
    accessToken: string,
    input: {
      challengeId: string;
      nonce: string;
      signature: string;
      name: string;
      publicKeyJwk: JsonWebKey;
    },
  ): Promise<RegistryPeer> {
    return this.call("/v1/peers", { method: "POST", body: JSON.stringify(input) }, accessToken);
  }

  credentials(
    accessToken: string,
    peerId: string,
    input: { challengeId: string; nonce: string; signature: string },
  ): Promise<RegistryPeer> {
    return this.call(
      `/v1/peers/${encodeURIComponent(peerId)}/credentials`,
      { method: "POST", body: JSON.stringify(input) },
      accessToken,
    );
  }
}

export function loadOrCreateIdentity(storage: StorageLike): Promise<IdentityKeyPair> {
  const saved = storage.getItem(REGISTRY_IDENTITY_KEY);
  if (saved) {
    try {
      const value = JSON.parse(saved) as StoredIdentity;
      return importIdentity({
        identityId: value.identityId,
        publicKeyJwk: value.publicKeyJwk,
        privateKeyJwk: value.privateKeyJwk,
      });
    } catch {
      storage.removeItem(REGISTRY_IDENTITY_KEY);
    }
  }
  return generateIdentity(`device-${crypto.randomUUID().slice(0, 12)}`, {
    extractable: true,
  }).then(async (identity) => {
    const value = await exportIdentity(identity);
    storage.setItem(REGISTRY_IDENTITY_KEY, JSON.stringify(value));
    return identity;
  });
}

export function loadStoredPeer(storage: StorageLike): RegistryPeer | null {
  const raw = storage.getItem(REGISTRY_PEER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RegistryPeer;
  } catch {
    storage.removeItem(REGISTRY_PEER_KEY);
    return null;
  }
}

const proof = (purpose: "register" | "credentials", challengeId: string, nonce: string) =>
  `p2plink-registry:${purpose}:${challengeId}:${nonce}`;

export async function ensureRegistryPeer(input: {
  api: RegistryApi;
  accessToken: string;
  storage: StorageLike;
  name: string;
}): Promise<RegistryPeer> {
  const identity = await loadOrCreateIdentity(input.storage);
  const stored = loadStoredPeer(input.storage);
  if (stored) {
    const challenge = await input.api.challenge(
      input.accessToken,
      "CREDENTIALS",
      undefined,
      stored.peer.peerId,
    );
    const signature = toBase64Url(
      await identity.sign(
        new TextEncoder().encode(proof("credentials", challenge.challengeId, challenge.nonce)),
      ),
    );
    const peer = await input.api.credentials(input.accessToken, stored.peer.peerId, {
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      signature,
    });
    input.storage.setItem(REGISTRY_PEER_KEY, JSON.stringify(peer));
    return peer;
  }
  const challenge = await input.api.challenge(input.accessToken, "REGISTER", identity.publicKeyJwk);
  const signature = toBase64Url(
    await identity.sign(
      new TextEncoder().encode(proof("register", challenge.challengeId, challenge.nonce)),
    ),
  );
  const peer = await input.api.registerPeer(input.accessToken, {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    signature,
    name: input.name,
    publicKeyJwk: identity.publicKeyJwk,
  });
  input.storage.setItem(REGISTRY_PEER_KEY, JSON.stringify(peer));
  return peer;
}

export function clearRegistryStorage(storage: StorageLike): void {
  storage.removeItem(REGISTRY_IDENTITY_KEY);
  storage.removeItem(REGISTRY_PEER_KEY);
}
