import {
  DEFAULT_MESH_MAX_HOPS,
  MAX_MESH_PAYLOAD_CHARS,
  P2PLinkError,
  P2PLinkErrorCodes,
  createEnvelope,
  encodeEnvelopeJson,
  isMeshRelayPayload,
  randomId,
  resolveMaxHops,
  type Envelope,
  type Logger,
  type MeshRelayHeader,
  type TransportKind,
} from "@p2plink/core";

/** A sealed (encrypted) frame destined to a specific peer id. */
export type MeshFrameSender = (peerId: string, frame: Uint8Array) => Promise<void>;

export interface MeshManagerOptions {
  /** Logical id of this node in the mesh (e.g. the demo "peer name"). */
  selfId: string;
  /** Maximum relay hops before a message falls back to MQTT (default: ENV or 3). */
  maxHops?: number;
  /** Delivers a sealed frame to the direct session with the given peer. */
  sendFrame: MeshFrameSender;
  /** True when a direct session with the peer exists and its transport is open. */
  hasDirectLink: (peerId: string) => boolean;
  /** Candidate relays for a destination (usually the peers connected to it). */
  getCandidates: (destinationId: string) => Iterable<string>;
  limits?: { maxFrameBytes?: number };
  logger?: Logger;
  now?: () => number;
  idFactory?: () => string;
}

interface RelayStats {
  forwarded: number;
  dropped: number;
}

/**
 * Peer-to-peer mesh routing on top of the E2E-encrypted pairwise sessions.
 *
 * When a message cannot travel on a direct link — or the remaining hop budget
 * would not allow it — it is wrapped in a plaintext {@link MeshRelayHeader}
 * and forwarded over the encrypted session with an intermediate peer, which
 * re-wraps it and repeats. Only when no route fits within `maxHops` does the
 * caller fall back to MQTT. The sealed payload stays opaque to relays.
 */
export class MeshManager {
  readonly maxHops: number;
  private readonly selfId: string;
  private readonly sendFrame: MeshFrameSender;
  private readonly hasDirectLink: (peerId: string) => boolean;
  private readonly getCandidates: (destinationId: string) => Iterable<string>;
  private readonly maxFrameBytes: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  /** envelope id -> delivery promise, so response/error envelopes reuse the route. */
  private readonly routes = new Map<string, MeshRoute>();
  private readonly seen = new Map<string, number>();
  private readonly relays = new Map<string, RelayStats>();
  private closed = false;

  constructor(options: MeshManagerOptions) {
    this.selfId = options.selfId;
    this.maxHops = resolveMaxHops(options.maxHops);
    this.sendFrame = options.sendFrame;
    this.hasDirectLink = options.hasDirectLink;
    this.getCandidates = options.getCandidates;
    this.maxFrameBytes = options.limits?.maxFrameBytes ?? 256 * 1024;
    this.logger = options.logger ?? {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? randomId;
  }

  get stats(): { routes: number; seen: number; relays: Record<string, RelayStats> } {
    const byPeer: Record<string, RelayStats> = {};
    for (const [peer, stats] of this.relays) byPeer[peer] = { ...stats };
    return { routes: this.routes.size, seen: this.seen.size, relays: byPeer };
  }

  /**
   * Routes a sealed frame towards `destinationId`. Returns `"mesh"` when the
   * frame travelled through at least one relayed session, `"webrtc"`/`"mqtt"`
   * when a direct link was used, or `null` when no route fits within the hop
   * budget (the caller must then fall back to MQTT itself).
   */
  async deliver(
    destinationId: string,
    sessionId: string,
    envelope: Envelope,
    sealedFrame: Uint8Array,
  ): Promise<TransportKind | null> {
    if (this.closed) return null;
    // Direct link wins: zero extra latency, zero trust in relays.
    if (destinationId === this.selfId || this.hasDirectLink(destinationId)) return null;
    const existing = this.routes.get(envelope.id);
    if (existing) {
      try {
        await this.sendFrame(existing.nextHop, sealedFrame);
        return "mesh";
      } catch (error) {
        this.forgetRoute(envelope.id);
        this.logger.warn("mesh route broken, recomputing", {
          destination: destinationId,
          envelopeId: envelope.id,
          error: P2PLinkError.from(error).message,
        });
      }
    }
    const nextHop = this.selectNextHop(destinationId);
    if (!nextHop) return null;
    const header: MeshRelayHeader = {
      v: 1,
      src: this.selfId,
      dst: destinationId,
      hop: 0,
      maxHop: this.maxHops,
      payload: JSON.stringify(sealedToWire(envelope, sealedFrame)),
    };
    const wireEnvelope = createEnvelope("request", sessionId, header, { id: this.idFactory() });
    let wire: Uint8Array;
    try {
      wire = encodeEnvelopeJson(wireEnvelope, this.maxFrameBytes);
    } catch (error) {
      const normalized = P2PLinkError.from(error);
      if (normalized.code === P2PLinkErrorCodes.PAYLOAD_TOO_LARGE) {
        this.logger.debug("message too large for mesh, use mqtt fallback", {
          destination: destinationId,
        });
        return null;
      }
      throw normalized;
    }
    await this.sendFrame(nextHop, wire);
    this.rememberRoute(envelope.id, {
      destination: destinationId,
      sessionId,
      nextHop,
      expiresAt: this.now() + MeshManager.ROUTE_TTL_MS,
    });
    this.logger.debug("mesh relay attempt", {
      destination: destinationId,
      nextHop,
      maxHop: this.maxHops,
    });
    return "mesh";
  }

  /** Forgets cached routes when a peer session goes away. */
  handlePeerGone(peerId: string): void {
    for (const [id, route] of this.routes) {
      if (route.nextHop === peerId) this.routes.delete(id);
    }
  }

  /** True when the sender of an inbound frame is on the cached route back. */
  expectsReplyVia(envelopeId: string, senderPeerId: string): boolean {
    const route = this.routes.get(envelopeId);
    return !!route && route.nextHop === senderPeerId;
  }

  close(): void {
    this.closed = true;
    this.routes.clear();
    this.seen.clear();
    this.relays.clear();
  }

  /**
   * Handles an inbound envelope that carries a mesh relay header. Returns true
   * when the envelope was consumed by the mesh layer (delivered locally or
   * forwarded), false when the caller should process it normally.
   */
  async handleIncoming(
    envelope: Envelope,
    senderPeerId: string | undefined,
    deliverLocal: (inner: Envelope, via: TransportKind) => void,
    forwardSealed: (
      nextHop: string,
      innerWire: Uint8Array,
      header: MeshRelayHeader,
    ) => Promise<TransportKind | null>,
  ): Promise<boolean> {
    if (this.closed) return false;
    if (!isMeshRelayPayload(envelope.payload)) return false;
    const header = envelope.payload;
    if (header.dst === this.selfId) {
      this.deliverLocally(envelope.id, header, deliverLocal);
      return true;
    }
    if (header.hop + 1 > header.maxHop) {
      this.logger.debug("mesh hop budget exhausted, destination must fall back to mqtt", {
        destination: header.dst,
        hop: header.hop,
        maxHop: header.maxHop,
      });
      return true;
    }
    if (this.isDuplicate(`f:${envelope.id}`)) {
      this.logger.debug("dropping duplicate mesh relay", { envelopeId: envelope.id });
      return true;
    }
    const nextHop = this.selectNextHop(header.dst);
    const stats = this.relays.get(senderPeerId ?? "?") ?? { forwarded: 0, dropped: 0 };
    if (!nextHop || nextHop === senderPeerId) {
      stats.dropped += 1;
      this.relays.set(senderPeerId ?? "?", stats);
      // No usable relay here: drop silently, the origin will fall back to MQTT.
      return true;
    }
    const innerWire = wireFromPayload(header.payload);
    if (!innerWire) {
      stats.dropped += 1;
      this.relays.set(senderPeerId ?? "?", stats);
      return true;
    }
    try {
      const delivered = await forwardSealed(nextHop, innerWire, {
        ...header,
        hop: header.hop + 1,
      });
      if (delivered !== null) stats.forwarded += 1;
      else stats.dropped += 1;
    } catch (error) {
      stats.dropped += 1;
      this.logger.warn("mesh forward failed", {
        destination: header.dst,
        nextHop,
        error: P2PLinkError.from(error).message,
      });
    }
    this.relays.set(senderPeerId ?? "?", stats);
    return true;
  }

  private deliverLocally(
    envelopeId: string,
    header: MeshRelayHeader,
    deliverLocal: (inner: Envelope, via: TransportKind) => void,
  ): void {
    if (this.isDuplicate(`d:${envelopeId}:${header.src}`)) return;
    const inner = wireFromPayload(header.payload);
    if (!inner) {
      this.logger.warn("dropping malformed mesh payload", { envelopeId });
      return;
    }
    let decoded: Envelope;
    try {
      decoded = decodeEnvelopeJson(inner.bytes, MAX_MESH_PAYLOAD_CHARS);
    } catch (error) {
      this.logger.warn("dropping undecodable mesh envelope", {
        envelopeId,
        error: P2PLinkError.from(error).message,
      });
      return;
    }
    // Cache the reverse route so responses/errors ride the same path back.
    this.rememberRoute(decoded.id, {
      destination: header.src,
      sessionId: decoded.sid,
      nextHop: inner.sender ?? header.src,
      expiresAt: this.now() + MeshManager.ROUTE_TTL_MS,
    });
    deliverLocal(decoded, "mesh");
  }

  private selectNextHop(destinationId: string): string | null {
    let fallback: string | null = null;
    for (const candidate of this.getCandidates(destinationId)) {
      if (candidate === this.selfId || candidate === destinationId) continue;
      if (!this.hasDirectLink(candidate)) continue;
      // Prefer a peer known to be directly connected to the destination.
      if (this.knowsDirectConnection(candidate, destinationId)) return candidate;
      fallback ??= candidate;
    }
    return fallback;
  }

  /**
   * Default heuristic: a peer that is itself directly linked to the
   * destination is the best last-hop relay. Applications may refine the
   * candidate list ordering instead.
   */
  private knowsDirectConnection(candidate: string, destinationId: string): boolean {
    return candidate === destinationId && this.hasDirectLink(destinationId);
  }

  private rememberRoute(envelopeId: string, route: MeshRoute): void {
    this.sweepExpired();
    this.routes.set(envelopeId, route);
  }

  private forgetRoute(envelopeId: string): void {
    this.routes.delete(envelopeId);
  }

  private isDuplicate(key: string): boolean {
    const now = this.now();
    this.pruneSeen(now);
    if (this.seen.has(key)) return true;
    this.seen.set(key, now + MeshManager.SEEN_TTL_MS);
    return false;
  }

  private pruneSeen(now: number): void {
    if (this.seen.size < 512) return;
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
  }

  private sweepExpired(): void {
    if (this.routes.size < 256) return;
    const now = this.now();
    for (const [key, route] of this.routes) {
      if (route.expiresAt <= now) this.routes.delete(key);
    }
  }

  private static readonly ROUTE_TTL_MS = 60_000;
  private static readonly SEEN_TTL_MS = 30_000;
}

interface MeshRoute {
  destination: string;
  sessionId: string;
  nextHop: string;
  expiresAt: number;
}

interface SealedWire {
  sid: string;
  seq: number;
  data: string;
  sender?: string;
}

function sealedToWire(envelope: Envelope, sealedFrame: Uint8Array): SealedWire {
  return {
    sid: envelope.sid,
    seq: parseSeq(sealedFrame),
    data: bytesToBase64(sealedFrame),
  };
}

/** Sequence number of the sealed frame (byte 0 kind, 1..8 counter, 9..12 seq). */
function parseSeq(frame: Uint8Array): number {
  if (frame.length < 13) return 0;
  return ((frame[9] ?? 0) * 2 ** 24 + (frame[10] ?? 0) * 2 ** 16 + (frame[11] ?? 0) * 2 ** 8 + (frame[12] ?? 0)) >>> 0;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64_ALPHABET[b2 & 63];
  }
  return out;
}

function base64ToBytes(value: string): Uint8Array | null {
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(value)) return null;
  const lookup = new Map<string, number>();
  for (let i = 0; i < B64_ALPHABET.length; i++) lookup.set(B64_ALPHABET[i] as string, i);
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((value.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < value.length; i += 4) {
    const c0 = lookup.get(value.slice(i, i + 1));
    const c1 = lookup.get(value.slice(i + 1, i + 2));
    const c2Raw = value.slice(i + 2, i + 3);
    const c3Raw = value.slice(i + 3, i + 4);
    const c2 = c2Raw === "=" ? 0 : lookup.get(c2Raw);
    const c3 = c3Raw === "=" ? 0 : lookup.get(c3Raw);
    if (c0 === undefined || c1 === undefined || c2 === undefined || c3 === undefined) return null;
    if (o < out.length) out[o++] = ((c0 << 2) | (c1 >> 4)) & 255;
    if (o < out.length) out[o++] = ((c1 << 4) | (c2 >> 2)) & 255;
    if (o < out.length) out[o++] = ((c2 << 6) | c3) & 255;
  }
  return out;
}

function wireFromPayload(payload: string): { bytes: Uint8Array; sender?: string } | null {
  if (payload.length > MAX_MESH_PAYLOAD_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as SealedWire).data !== "string"
  ) {
    return null;
  }
  const wire = value as SealedWire;
  const bytes = base64ToBytes(wire.data);
  if (!bytes || bytes.length === 0) return null;
  return {
    bytes,
    ...(typeof wire.sender === "string" ? { sender: wire.sender } : {}),
  };
}
