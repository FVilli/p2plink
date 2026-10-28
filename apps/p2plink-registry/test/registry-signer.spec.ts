import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateIdentity, publicKeyFingerprint } from "@p2plink/crypto";
import { importJWK, jwtVerify } from "jose";
import { verifyPeerCertificate } from "../src/registry/peer-certificate.js";

let dir: string;
let signer: import("../src/registry/registry-signer.service.js").RegistrySignerService;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "p2plink-registry-test-"));
  process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:1/unused";
  process.env.JWT_SECRET = "test-secret-012345678901234567890123";
  process.env.MQTT_PUBLIC_URL = "ws://127.0.0.1:9001";
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = "465";
  process.env.SMTP_USER = "noreply@example.test";
  process.env.SMTP_PASSWORD = "not-used";
  process.env.EMAIL = "noreply@example.test";
  process.env.EMAIL_SECRET = "not-used";
  process.env.REGISTRY_KEY_FILE = join(dir, "registry-key.json");
  const { RegistrySignerService } = await import("../src/registry/registry-signer.service.js");
  signer = new RegistrySignerService();
  await signer.onModuleInit();
});

afterAll(async () => {
  delete process.env.REGISTRY_KEY_FILE;
  await rm(dir, { recursive: true, force: true });
});

describe("registry peer certificates", () => {
  it("signs a verifiable certificate with the registry key", async () => {
    const identity = await generateIdentity("peer-test");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 60_000);
    const signed = await signer.signPeerCertificate({
      peerId: "p_test",
      userId: "user-1",
      publicKeyJwk: identity.publicKeyJwk,
      fingerprint: await publicKeyFingerprint(identity.publicKeyJwk),
      serial: "serial-1",
      issuedAt,
      expiresAt,
    });
    const key = await importJWK(signer.publicJwk(), "ES256");
    const result = await jwtVerify(signed.token, key, {
      algorithms: ["ES256"],
      issuer: "p2plink-registry",
      audience: "p2plink-peer",
    });
    expect(result.payload.sub).toBe("p_test");
    expect(result.payload.userId).toBe("user-1");
    expect(result.protectedHeader.typ).toBe("p2plink-peer-cert");
    expect(signed.expiresAt).toEqual(expiresAt);
    const verified = await verifyPeerCertificate(signed.token, signer.publicJwk());
    expect(verified.payload.sub).toBe("p_test");
    expect(verified.payload.serial).toBe("serial-1");
  });
});
