import { randomToken } from "@p2plink/core";
import type { IssueLevel, MeshIssue, PeerKind, PresenceMessage, TrafficView } from "./types.js";

/** Bumped when the demo wire layout changes; keeps stale tabs isolated. */
export const DEMO_PROTOCOL_VERSION = 2;
/** v2 isolates old clients that still publish presence every 2 seconds. */
export const MESH_PREFIX = "p2plink-demo/v2";
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

export function issueTopic(peerId: string): string {
  return `${MESH_PREFIX}/issues/${peerId}`;
}

export function issuesInboxTopic(): string {
  return `${MESH_PREFIX}/issues/+`;
}

export function makePresence(input: {
  peerId: string;
  name: string;
  kind: PeerKind;
  version: string;
  identityId: string;
  identityPublicKey: JsonWebKey;
  traffic: TrafficView;
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
    traffic: input.traffic,
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

export function makeIssue(input: {
  id: string;
  peerId: string;
  name: string;
  kind: PeerKind;
  version: string;
  level: IssueLevel;
  message: string;
  context: Record<string, string | number | boolean>;
}): MeshIssue {
  return {
    v: 2,
    type: "issue",
    id: input.id,
    peerId: input.peerId,
    name: input.name,
    kind: input.kind,
    version: input.version,
    level: input.level,
    message: input.message.slice(0, 300),
    context: input.context,
    ts: Date.now(),
  };
}
