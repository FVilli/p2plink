import type { SerializedError } from "./types.js";

export type EnvelopeType =
  "request" | "response" | "error" | "event" | "ping" | "pong" | "close" | "signal";

export interface Envelope {
  v: 1;
  id: string;
  sid: string;
  type: EnvelopeType;
  ts: number;
  cid?: string;
  /** Optional client-supplied idempotency key, scoped by authenticated identity. */
  idem?: string;
  payload: unknown;
}

export interface EventPayload {
  event: string;
  data: unknown;
}

export interface ClosePayload {
  reason: string;
  code?: string;
}

export interface SessionDescriptionInit {
  type: "offer" | "answer";
  sdp: string;
}

export interface IceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface SignalOffer {
  kind: "offer";
  negotiationId: string;
  epoch: number;
  sdp: SessionDescriptionInit;
}

export interface SignalAnswer {
  kind: "answer";
  negotiationId: string;
  epoch: number;
  sdp: SessionDescriptionInit;
}

export interface SignalIce {
  kind: "ice";
  negotiationId: string;
  epoch: number;
  candidate: IceCandidateInit;
}

export interface SignalBye {
  kind: "bye";
  negotiationId: string;
  epoch: number;
  reason?: string;
}

export type SignalPayload = SignalOffer | SignalAnswer | SignalIce | SignalBye;

export interface SignalReset {
  v: 1;
  kind: "session-reset";
  clientId?: string;
  sessionId?: string;
  reason: string;
  issuedAt?: number;
  /** ECDSA P-256/SHA-256 over the canonical reset payload. */
  signature?: string;
}

export type ErrorEnvelopePayload = SerializedError;
