import { describe, expect, it } from "vitest";
import {
  P2PLinkError,
  createEnvelope,
  decodeEnvelopeJson,
  encodeEnvelopeJson,
  isSecureFrame,
  sessionTopics,
  validateEnvelope,
} from "../index.js";

const sid = "abcdefghijklmnop";

describe("envelope protocol", () => {
  it("round-trips a request", () => {
    const env = createEnvelope("request", sid, { method: "users.get", params: { id: "1" } });
    const bytes = encodeEnvelopeJson(env, 64 * 1024);
    expect(decodeEnvelopeJson(bytes, 64 * 1024)).toEqual(env);
  });

  it("rejects oversized envelopes", () => {
    const env = createEnvelope("request", sid, { data: "x".repeat(200) });
    expect(() => encodeEnvelopeJson(env, 100)).toThrowError(P2PLinkError);
  });

  it("rejects unknown types and malformed errors", () => {
    expect(() =>
      validateEnvelope({ ...createEnvelope("request", sid, null), type: "nope" }),
    ).toThrow();
    expect(() =>
      validateEnvelope({ ...createEnvelope("error", sid, null), payload: { code: 1 } }),
    ).toThrow();
  });

  it("validates signaling payloads", () => {
    const env = createEnvelope("signal", sid, {
      kind: "offer",
      negotiationId: "neg-1",
      epoch: 0,
      sdp: { type: "offer", sdp: "v=0\r\n" },
    });
    expect(() => validateEnvelope(env)).not.toThrow();
    expect(() =>
      validateEnvelope({ ...env, payload: { ...(env.payload as object), epoch: -1 } }),
    ).toThrow();
  });

  it("builds tenant-scoped topics and rejects injection", () => {
    expect(sessionTopics({ tenant: "acme", serverId: "srv-1", clientId: "cli-1" })).toEqual({
      sessionC2s: "p2plink/v1/acme/srv-1/session/cli-1/c2s",
      sessionS2c: "p2plink/v1/acme/srv-1/session/cli-1/s2c",
      signalS2c: "p2plink/v1/acme/srv-1/signal/cli-1/s2c",
    });
    expect(() =>
      sessionTopics({ tenant: "acme", serverId: "srv-1", clientId: "bad/../#" }),
    ).toThrow();
  });

  it("recognizes secure frames", () => {
    expect(isSecureFrame(new Uint8Array([2, 1]))).toBe(true);
    expect(isSecureFrame(new Uint8Array([1, 1]))).toBe(false);
  });
});
