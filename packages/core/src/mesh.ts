import { P2PLinkError, P2PLinkErrorCodes } from "./errors.js";
import { isPlainObject } from "./util.js";
import type { Envelope } from "./protocol-types.js";

/**
 * Mesh relay protocol (application level, on top of the E2E-encrypted
 * session transports). A peer that cannot reach the destination directly —
 * or within the remaining hop budget — forwards the sealed frame to an
 * intermediate peer, which re-wraps it and repeats until the destination is
 * reached. Intermediaries only ever see this plaintext header; the inner
 * envelope stays encrypted end-to-end.
 */

export const MESH_HEADER_VERSION = 1;

/** Default maximum number of relay hops before falling back to the broker. */
export const DEFAULT_MESH_MAX_HOPS = 3;

/** Hard ceiling for the configured hop limit, to keep relays cheap. */
export const MAX_MESH_MAX_HOPS = 8;

/** Upper bound accepted for a relayed envelope payload (JSON characters). */
export const MAX_MESH_PAYLOAD_CHARS = 512 * 1024;

export interface MeshRelayHeader {
  v: 1;
  /** Logical sender id (the application-level peer, not the last hop). */
  src: string;
  /** Logical destination id. */
  dst: string;
  /** Hops already performed by this message. */
  hop: number;
  /** Maximum hops allowed for this message (<= maxRelayHops of every relay). */
  maxHop: number;
  /** The original (already sealed) envelope, JSON-encoded. */
  payload: string;
}

export function isMeshRelayEnvelope(envelope: Envelope): boolean {
  return envelope.type === "request" && isMeshRelayPayload(envelope.payload);
}

export function isMeshRelayPayload(payload: unknown): payload is MeshRelayHeader {
  if (!isPlainObject(payload)) return false;
  return (
    payload.v === MESH_HEADER_VERSION &&
    typeof payload.src === "string" &&
    typeof payload.dst === "string" &&
    typeof payload.hop === "number" &&
    typeof payload.maxHop === "number" &&
    typeof payload.payload === "string"
  );
}

export function encodeMeshRelayHeader(header: MeshRelayHeader): Uint8Array {
  validateMeshRelayHeader(header);
  return new TextEncoder().encode(JSON.stringify(header));
}

export function decodeMeshRelayHeader(bytes: Uint8Array): MeshRelayHeader {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed mesh relay header", {
      cause: error,
    });
  }
  validateMeshRelayHeader(value);
  return value;
}

export function validateMeshRelayHeader(value: unknown): asserts value is MeshRelayHeader {
  if (!isPlainObject(value)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Mesh relay header must be an object");
  }
  if (value.v !== MESH_HEADER_VERSION) {
    throw new P2PLinkError(
      P2PLinkErrorCodes.UNSUPPORTED_VERSION,
      "Unsupported mesh relay header version",
    );
  }
  if (typeof value.src !== "string" || !isShortId(value.src)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid mesh relay source id");
  }
  if (typeof value.dst !== "string" || !isShortId(value.dst)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid mesh relay destination id");
  }
  if (!isHopCount(value.hop)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid mesh relay hop count");
  }
  if (!isHopCount(value.maxHop)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid mesh relay hop limit");
  }
  if (typeof value.payload !== "string" || value.payload.length < 2) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Missing mesh relay payload");
  }
  if (value.payload.length > MAX_MESH_PAYLOAD_CHARS) {
    throw new P2PLinkError(
      P2PLinkErrorCodes.PAYLOAD_TOO_LARGE,
      `Mesh relay payload is ${value.payload.length} chars, limit is ${MAX_MESH_PAYLOAD_CHARS}`,
    );
  }
}

function isShortId(value: string): boolean {
  return value.length > 0 && value.length <= 128;
}

function isHopCount(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000;
}

/**
 * Resolves the mesh hop limit. Precedence: explicit option, then the
 * `P2PLINK_MESH_MAX_HOPS` environment variable (Node/dotenv), then the
 * default (3). Invalid or out-of-range values fall back to the default.
 */
export function resolveMaxHops(explicit?: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw =
    explicit ??
    (typeof env["P2PLINK_MESH_MAX_HOPS"] === "string" ? env["P2PLINK_MESH_MAX_HOPS"] : undefined);
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MESH_MAX_HOPS;
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_MESH_MAX_HOPS // eslint-disable-line no-restricted-globals -- parseInt above guards NaN
  ) {
    return DEFAULT_MESH_MAX_HOPS;
  }
  return parsed;
}
