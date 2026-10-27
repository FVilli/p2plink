import { randomToken } from "@p2plink/core";
import type { PeerKind, PresenceMessage } from "./types.js";

export const DEMO_PROTOCOL_VERSION = 1;
export const MESH_PREFIX = "p2plink-demo/v1";
export const DEMO_TENANT = "demo";
export const DEMO_SERVER_ID = "mesh";
export const DEMO_CAPABILITY = "demo-tofu-capability-0000000000000000";

export function newPeerId(): string {
  return randomToken(9);
}

export function presenceTopic(peerId: string): string {
  return `${MESH_PREFIX}/presence/${peerId}`;
}

export function presenceInboxTopic(): string {
  return `${MESH_PREFIX}/presence/+`;
}

export function signalInboxTopic(peerId: string): string {
  return `${MESH_PREFIX}/signal/${peerId}/+`;
}

export function signalTopic(to: string, from: string): string {
  return `${MESH_PREFIX}/signal/${to}/${from}`;
}

export function dataTopic(to: string, from: string): string {
  return `${MESH_PREFIX}/data/${to}/${from}`;
}

export function makePresence(input: {
  peerId: string;
  name: string;
  kind: PeerKind;
  version: string;
  identityId: string;
  identityPublicKey: JsonWebKey;
}): PresenceMessage {
  return {
    v: DEMO_PROTOCOL_VERSION,
    type: "presence",
    peerId: input.peerId,
    name: input.name,
    kind: input.kind,
    version: input.version,
    identityId: input.identityId,
    identityPublicKey: input.identityPublicKey,
    ts: Date.now(),
  };
}

export function makeLeave(
  peerId: string,
  name: string,
  kind: PeerKind,
  version: string,
): PresenceMessage {
  return {
    v: DEMO_PROTOCOL_VERSION,
    type: "leave",
    peerId,
    name,
    kind,
    version,
    identityId: "",
    identityPublicKey: { kty: "EC", crv: "P-256", x: "", y: "" },
    ts: Date.now(),
  };
}
