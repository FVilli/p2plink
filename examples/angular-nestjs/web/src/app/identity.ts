import {
  exportIdentity,
  generateIdentity,
  importIdentity,
  type IdentityKeyPair,
} from "@p2plink/crypto";

const KEY = "p2plink-angular-identity";

export async function loadIdentity(): Promise<IdentityKeyPair> {
  const stored = localStorage.getItem(KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as {
        identityId: string;
        publicKeyJwk: JsonWebKey;
        privateKeyJwk: JsonWebKey;
      };
      return await importIdentity(parsed);
    } catch {
      localStorage.removeItem(KEY);
    }
  }
  const identity = await generateIdentity("client-demo", { extractable: true });
  const exported = await exportIdentity(identity);
  localStorage.setItem(KEY, JSON.stringify(exported));
  return identity;
}

export function apiBase(): string {
  return location.port === "4200" ? "http://127.0.0.1:3000" : "";
}
