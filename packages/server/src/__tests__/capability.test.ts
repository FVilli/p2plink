import { describe, expect, it } from "vitest";
import { generateIdentity, publicKeyFingerprint } from "@p2plink/crypto";
import { MemoryCapabilityStore, issueCapability, verifyCapability } from "../capability.js";

async function makeCapability(options: { now?: () => number; ttlMs?: number } = {}) {
  const identity = await generateIdentity("server-1");
  const fingerprint = await publicKeyFingerprint(identity.publicKeyJwk);
  const { capability, claims } = await issueCapability(identity, {
    subject: "user-1",
    clientId: "client-1",
    tenant: "t1",
    serverId: "s1",
    identityFingerprint: fingerprint,
    ttlMs: options.ttlMs ?? 60_000,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { identity, capability, claims, fingerprint };
}

describe("bootstrap capabilities", () => {
  it("verifies a valid capability and rejects tampering", async () => {
    const { identity, capability, fingerprint } = await makeCapability();
    const claims = await verifyCapability(capability, {
      publicKeyJwk: identity.publicKeyJwk,
      tenant: "t1",
      serverId: "s1",
    });
    expect(claims.sub).toBe("user-1");
    expect(claims.identityFingerprint).toBe(fingerprint);

    const [header, payload, signature] = capability.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    decoded.clientId = "attacker";
    const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    const tampered = `${header}.${tamperedPayload}.${signature}`;
    await expect(
      verifyCapability(tampered, {
        publicKeyJwk: identity.publicKeyJwk,
        tenant: "t1",
        serverId: "s1",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_INVALID" });
  });

  it("rejects expired capabilities and wrong targets", async () => {
    const { identity, capability } = await makeCapability({ now: () => 0, ttlMs: 1_000 });
    await expect(
      verifyCapability(
        capability,
        {
          publicKeyJwk: identity.publicKeyJwk,
          tenant: "t1",
          serverId: "s1",
        },
        { now: () => 100_000 },
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_INVALID" });

    const other = await makeCapability();
    await expect(
      verifyCapability(other.capability, {
        publicKeyJwk: identity.publicKeyJwk,
        tenant: "other",
        serverId: "s1",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_INVALID" });
  });

  it("consumes a nonce only once", async () => {
    const store = new MemoryCapabilityStore();
    expect(await store.consume("nonce", Date.now() + 60_000)).toBe(true);
    expect(await store.consume("nonce", Date.now() + 60_000)).toBe(false);
  });
});
