import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  exportIdentity,
  generateIdentity,
  importIdentity,
  type IdentityKeyPair,
} from "@p2plink/crypto";

export async function loadServerIdentity(): Promise<IdentityKeyPair> {
  const file = resolve(process.cwd(), ".data/server-identity.json");
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, "utf8")) as {
      identityId: string;
      publicKeyJwk: JsonWebKey;
      privateKeyJwk: JsonWebKey;
    };
    return importIdentity(stored);
  }
  const identity = await generateIdentity("demo-server", { extractable: true });
  const exported = await exportIdentity(identity);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(exported, null, 2), { mode: 0o600 });
  return identity;
}
