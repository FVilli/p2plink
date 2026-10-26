import { describe, expect, it } from "vitest";
import { P2PLinkError, randomToken, utf8Encode } from "@p2plink/core";
import {
  TransportSecurity,
  completeClientHandshake,
  completeServerHandshake,
  createClientHello,
  createServerHello,
  generateIdentity,
  publicKeyFingerprint,
  verifyClientHello,
} from "../index.js";

const tenant = "test";
const serverId = "server-1";
const clientId = "client-1";
const sessionId = randomToken(16);
const capability = "cap_".padEnd(64, "x");

async function establish(clockNow = Date.now()) {
  const clientIdentity = await generateIdentity("client-1", { extractable: true });
  const serverIdentity = await generateIdentity("server-1", { extractable: true });
  const fingerprint = await publicKeyFingerprint(clientIdentity.publicKeyJwk);
  const clientState = await createClientHello({
    tenant,
    serverId,
    clientId,
    sessionId,
    capability,
    identity: clientIdentity,
    now: () => clockNow,
  });
  const verified = await verifyClientHello(clientState.hello, {
    tenant,
    serverId,
    validateCapability: async () => ({ clientId, identityFingerprint: fingerprint }),
    now: () => clockNow,
  });
  const { hello: serverHello, state: serverState } = await createServerHello(
    verified,
    serverIdentity,
    { now: () => clockNow },
  );
  const clientSession = await completeClientHandshake(clientState, serverHello, {
    serverIdentityPin: { publicKeyJwk: serverIdentity.publicKeyJwk },
    now: () => clockNow,
  });
  const serverSession = await completeServerHandshake(serverState);
  return { clientSession, serverSession, clientIdentity, serverIdentity, clientState, serverHello };
}

describe("authenticated handshake", () => {
  it("derives interoperable MQTT and WebRTC keys", async () => {
    const { clientSession, serverSession } = await establish();
    const client = new TransportSecurity(clientSession, "client");
    const server = new TransportSecurity(serverSession, "server");
    for (const transport of ["mqtt", "webrtc"] as const) {
      const frame = await client.seal(transport, utf8Encode(`hello-${transport}`));
      expect(new TextDecoder().decode(await server.open(transport, frame))).toBe(`hello-${transport}`);
      const back = await server.seal(transport, utf8Encode("ack"));
      expect(new TextDecoder().decode(await client.open(transport, back))).toBe("ack");
    }
  });

  it("rejects a wrong pinned server identity", async () => {
    const clientIdentity = await generateIdentity("client-1", { extractable: true });
    const serverIdentity = await generateIdentity("server-1", { extractable: true });
    const attacker = await generateIdentity("attacker", { extractable: true });
    const fingerprint = await publicKeyFingerprint(clientIdentity.publicKeyJwk);
    const state = await createClientHello({
      tenant, serverId, clientId, sessionId, capability, identity: clientIdentity,
    });
    const verified = await verifyClientHello(state.hello, {
      tenant, serverId,
      validateCapability: async () => ({ clientId, identityFingerprint: fingerprint }),
    });
    const { hello } = await createServerHello(verified, serverIdentity);
    await expect(
      completeClientHandshake(state, hello, {
        serverIdentityPin: { publicKeyJwk: attacker.publicKeyJwk },
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("rejects a capability bound to another identity", async () => {
    const clientIdentity = await generateIdentity("client-1", { extractable: true });
    const other = await generateIdentity("other", { extractable: true });
    const fingerprint = await publicKeyFingerprint(other.publicKeyJwk);
    const state = await createClientHello({
      tenant, serverId, clientId, sessionId, capability, identity: clientIdentity,
    });
    await expect(
      verifyClientHello(state.hello, {
        tenant, serverId,
        validateCapability: async () => ({ clientId, identityFingerprint: fingerprint }),
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("rejects a tampered client hello", async () => {
    const { clientState } = await establish();
    const tampered = { ...clientState.hello, clientId: "other-client" };
    await expect(
      verifyClientHello(tampered, {
        tenant, serverId,
        validateCapability: async () => ({ clientId: "other-client", identityFingerprint: "x" }),
      }),
    ).rejects.toBeInstanceOf(P2PLinkError);
  });
});

describe("frame protection", () => {
  it("rejects replay, tampering and cross-transport frames", async () => {
    const { clientSession, serverSession } = await establish();
    const client = new TransportSecurity(clientSession, "client");
    const server = new TransportSecurity(serverSession, "server");
    const frame = await client.seal("mqtt", utf8Encode("payload"));
    expect(new TextDecoder().decode(await server.open("mqtt", frame))).toBe("payload");
    await expect(server.open("mqtt", frame)).rejects.toMatchObject({ code: "REPLAY_DETECTED" });

    const second = await client.seal("mqtt", utf8Encode("second"));
    const tampered = new Uint8Array(second);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(server.open("mqtt", tampered)).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
    expect(new TextDecoder().decode(await server.open("mqtt", second))).toBe("second");

    const webrtcFrame = await client.seal("webrtc", utf8Encode("p2p"));
    await expect(server.open("mqtt", webrtcFrame)).rejects.toBeInstanceOf(P2PLinkError);
  });

  it("accepts reordering inside the replay window", async () => {
    const { clientSession, serverSession } = await establish();
    const client = new TransportSecurity(clientSession, "client");
    const server = new TransportSecurity(serverSession, "server");
    const frames = await Promise.all(
      ["a", "b", "c"].map((value) => client.seal("mqtt", utf8Encode(value))),
    );
    expect(new TextDecoder().decode(await server.open("mqtt", frames[1]!))).toBe("b");
    expect(new TextDecoder().decode(await server.open("mqtt", frames[0]!))).toBe("a");
    expect(new TextDecoder().decode(await server.open("mqtt", frames[2]!))).toBe("c");
  });
});
