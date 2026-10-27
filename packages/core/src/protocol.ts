import { P2PLinkError, P2PLinkErrorCodes, isSerializedError } from "./errors.js";
import type { Envelope, EnvelopeType, SignalPayload, SignalReset } from "./protocol-types.js";
import { isPlainObject, randomId, utf8Decode, utf8Encode } from "./util.js";

export type {
  ClosePayload,
  Envelope,
  EnvelopeType,
  EventPayload,
  IceCandidateInit,
  SessionDescriptionInit,
  SignalPayload,
  SignalReset,
} from "./protocol-types.js";

export const PROTOCOL_VERSION = 1;

export const SESSION_MESSAGE_HANDSHAKE = 0x01;
export const SESSION_MESSAGE_SECURE = 0x02;

export interface CreateEnvelopeOptions {
  id?: string;
  cid?: string;
  idem?: string;
  ts?: number;
}

export function createEnvelope(
  type: EnvelopeType,
  sessionId: string,
  payload: unknown,
  options: CreateEnvelopeOptions = {},
): Envelope {
  const envelope: Envelope = {
    v: PROTOCOL_VERSION,
    id: options.id ?? randomId(),
    sid: sessionId,
    type,
    ts: options.ts ?? Date.now(),
    payload,
  };
  if (options.cid !== undefined) envelope.cid = options.cid;
  if (options.idem !== undefined) envelope.idem = options.idem;
  return envelope;
}

export function encodeEnvelopeJson(envelope: Envelope, maxBytes: number): Uint8Array {
  validateEnvelope(envelope);
  const bytes = utf8Encode(JSON.stringify(envelope));
  if (bytes.length > maxBytes) {
    throw new P2PLinkError(
      P2PLinkErrorCodes.PAYLOAD_TOO_LARGE,
      `Envelope is ${bytes.length} bytes, limit is ${maxBytes}`,
      { details: { size: bytes.length, maxBytes } },
    );
  }
  return bytes;
}

export function decodeEnvelopeJson(input: Uint8Array | string, maxBytes: number): Envelope {
  const bytes = typeof input === "string" ? utf8Encode(input) : input;
  if (bytes.length > maxBytes) {
    throw new P2PLinkError(
      P2PLinkErrorCodes.PAYLOAD_TOO_LARGE,
      `Envelope is ${bytes.length} bytes, limit is ${maxBytes}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(typeof input === "string" ? input : utf8Decode(bytes)) as unknown;
  } catch (error) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed JSON envelope", {
      cause: error,
    });
  }
  validateEnvelope(value);
  return value;
}

const ENVELOPE_TYPES: ReadonlySet<string> = new Set<EnvelopeType>([
  "request",
  "response",
  "error",
  "event",
  "ping",
  "pong",
  "close",
  "signal",
]);

export function validateEnvelope(value: unknown): asserts value is Envelope {
  if (!isPlainObject(value)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Envelope must be an object");
  }
  if (value.v !== PROTOCOL_VERSION) {
    throw new P2PLinkError(P2PLinkErrorCodes.UNSUPPORTED_VERSION, "Unsupported protocol version");
  }
  if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 128) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid envelope id");
  }
  if (typeof value.sid !== "string" || value.sid.length < 8 || value.sid.length > 128) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid session id");
  }
  if (typeof value.type !== "string" || !ENVELOPE_TYPES.has(value.type)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Unknown envelope type");
  }
  if (typeof value.ts !== "number" || !Number.isFinite(value.ts)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid envelope timestamp");
  }
  if (value.cid !== undefined && (typeof value.cid !== "string" || value.cid.length > 128)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid correlation id");
  }
  if (value.idem !== undefined && (typeof value.idem !== "string" || value.idem.length > 128)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid idempotency key");
  }
  if (!("payload" in value)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Missing envelope payload");
  }
  switch (value.type) {
    case "error":
      if (!isSerializedError(value.payload)) {
        throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed error payload");
      }
      break;
    case "event": {
      if (
        !isPlainObject(value.payload) ||
        typeof value.payload.event !== "string" ||
        value.payload.event.length > 128 ||
        !("data" in value.payload)
      ) {
        throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed event payload");
      }
      break;
    }
    case "close": {
      if (!isPlainObject(value.payload) || typeof value.payload.reason !== "string") {
        throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed close payload");
      }
      break;
    }
    case "signal":
      validateSignalPayload(value.payload);
      break;
    case "request":
    case "response":
    case "ping":
    case "pong":
      break;
  }
}

function isShortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function validateSignalPayload(value: unknown): asserts value is SignalPayload {
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed signaling payload");
  }
  if (!isShortString(value.negotiationId, 64) || !/^[A-Za-z0-9._-]+$/u.test(value.negotiationId)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid negotiation id");
  }
  if (
    typeof value.epoch !== "number" ||
    !Number.isInteger(value.epoch) ||
    value.epoch < 0 ||
    value.epoch > 2 ** 31 - 1
  ) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid signaling epoch");
  }
  switch (value.kind) {
    case "offer":
    case "answer": {
      const sdp = value.sdp;
      if (
        !isPlainObject(sdp) ||
        sdp.type !== value.kind ||
        typeof sdp.sdp !== "string" ||
        sdp.sdp.length === 0 ||
        sdp.sdp.length > 128 * 1024
      ) {
        throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed SDP");
      }
      break;
    }
    case "ice": {
      const candidate = value.candidate;
      if (
        !isPlainObject(candidate) ||
        typeof candidate.candidate !== "string" ||
        candidate.candidate.length > 8 * 1024
      ) {
        throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed ICE candidate");
      }
      break;
    }
    case "bye":
      break;
    default:
      throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Unknown signaling kind");
  }
}

export function validateSignalReset(value: unknown): asserts value is SignalReset {
  if (
    !isPlainObject(value) ||
    value.v !== PROTOCOL_VERSION ||
    value.kind !== "session-reset" ||
    typeof value.reason !== "string" ||
    value.reason.length > 256
  ) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed session reset");
  }
  if (
    value.clientId !== undefined &&
    (typeof value.clientId !== "string" || value.clientId.length > 64)
  ) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed session reset client id");
  }
  if (
    value.sessionId !== undefined &&
    (typeof value.sessionId !== "string" || value.sessionId.length > 128)
  ) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed session reset session id");
  }
  if (
    value.issuedAt !== undefined &&
    (typeof value.issuedAt !== "number" || !Number.isFinite(value.issuedAt))
  ) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed session reset timestamp");
  }
  if (
    value.signature !== undefined &&
    (typeof value.signature !== "string" || value.signature.length > 256)
  ) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed session reset signature");
  }
}

const HANDSHAKE_PREFIX = SESSION_MESSAGE_HANDSHAKE;

export function encodeHandshakeMessage(value: unknown): Uint8Array {
  const json = utf8Encode(JSON.stringify(value));
  if (json.length > 32 * 1024) {
    throw new P2PLinkError(P2PLinkErrorCodes.PAYLOAD_TOO_LARGE, "Handshake message too large");
  }
  const out = new Uint8Array(json.length + 1);
  out[0] = HANDSHAKE_PREFIX;
  out.set(json, 1);
  return out;
}

export function decodeHandshakeMessage(bytes: Uint8Array): unknown {
  if (bytes.length < 2 || bytes[0] !== HANDSHAKE_PREFIX) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Not a handshake message");
  }
  if (bytes.length > 32 * 1024) {
    throw new P2PLinkError(P2PLinkErrorCodes.PAYLOAD_TOO_LARGE, "Handshake message too large");
  }
  try {
    return JSON.parse(utf8Decode(bytes.subarray(1))) as unknown;
  } catch (error) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed handshake JSON", {
      cause: error,
    });
  }
}

export function isSecureFrame(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === SESSION_MESSAGE_SECURE;
}
