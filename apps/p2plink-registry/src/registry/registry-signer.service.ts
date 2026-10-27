import { Injectable, type OnModuleInit } from "@nestjs/common";
import { config } from "../config.js";
import { generateKeyPair, importPKCS8, importSPKI, exportJWK, SignJWT, type JWK } from "jose";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { PeerCertificateInput, RegistrySigner } from "./registry-signer.interface.js";

@Injectable()
export class RegistrySignerService implements RegistrySigner, OnModuleInit {
  readonly kid = config.registryKid;
  private privateKey!: CryptoKey;
  private jwk!: JWK;

  async onModuleInit(): Promise<void> {
    const path = config.registryKeyFile;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(path, "utf8")) as {
        privateKey: string;
        publicKey: string;
      };
      this.privateKey = await importPKCS8(saved.privateKey, "ES256");
      const publicKey = await importSPKI(saved.publicKey, "ES256");
      this.jwk = (await exportJWK(publicKey)) as JWK;
      await chmod(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const pair = await generateKeyPair("ES256", { extractable: true });
      const { exportPKCS8, exportSPKI } = await import("jose");
      const privateKey = await exportPKCS8(pair.privateKey);
      const publicKey = await exportSPKI(pair.publicKey);
      await writeFile(path, JSON.stringify({ privateKey, publicKey }), { mode: 0o600, flag: "wx" });
      await chmod(path, 0o600);
      this.privateKey = pair.privateKey;
      this.jwk = (await exportJWK(pair.publicKey)) as JWK;
    }
    this.jwk = { ...this.jwk, kid: this.kid, alg: "ES256", use: "sig" } as JWK;
  }

  publicJwk(): JsonWebKey {
    return { ...this.jwk } as JsonWebKey;
  }

  async signPeerCertificate(input: PeerCertificateInput) {
    const token = await new SignJWT({
      userId: input.userId,
      jwk: input.publicKeyJwk,
      fingerprint: input.fingerprint,
      serial: input.serial,
    })
      .setProtectedHeader({ alg: "ES256", typ: "p2plink-peer-cert", kid: this.kid })
      .setIssuer("p2plink-registry")
      .setAudience("p2plink-peer")
      .setSubject(input.peerId)
      .setIssuedAt(Math.floor(input.issuedAt.getTime() / 1000))
      .setNotBefore(Math.floor(input.issuedAt.getTime() / 1000))
      .setExpirationTime(Math.floor(input.expiresAt.getTime() / 1000))
      .sign(this.privateKey);
    return { token, serial: input.serial, expiresAt: input.expiresAt };
  }

  async signRevocation(input: { peerId: string; serial: string; reason: string; revokedAt: Date }) {
    const payload = {
      ...input,
      revokedAt: input.revokedAt.toISOString(),
      iss: "p2plink-registry",
      id: randomUUID(),
    };
    const event = await new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", typ: "p2plink-revocation", kid: this.kid })
      .sign(this.privateKey);
    return { event, payload };
  }
}
