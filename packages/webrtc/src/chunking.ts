import { P2PLinkError, P2PLinkErrorCodes, concatBytes } from "@p2plink/core";

export const PACKET_SINGLE = 0x10;
export const PACKET_CHUNK = 0x11;
const CHUNK_HEADER = 9;

export function encodeTransportPackets(
  frame: Uint8Array,
  chunkSize: number,
  messageId: number,
): Uint8Array[] {
  if (frame.length + 1 <= chunkSize) {
    const packet = new Uint8Array(frame.length + 1);
    packet[0] = PACKET_SINGLE;
    packet.set(frame, 1);
    return [packet];
  }
  const count = Math.ceil(frame.length / chunkSize);
  if (count > 0xffff) {
    throw new P2PLinkError(P2PLinkErrorCodes.PAYLOAD_TOO_LARGE, "Frame requires too many chunks");
  }
  const packets: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const chunk = frame.subarray(index * chunkSize, Math.min(frame.length, (index + 1) * chunkSize));
    const packet = new Uint8Array(CHUNK_HEADER + chunk.length);
    packet[0] = PACKET_CHUNK;
    new DataView(packet.buffer).setUint32(1, messageId >>> 0, false);
    new DataView(packet.buffer).setUint16(5, index, false);
    new DataView(packet.buffer).setUint16(7, count, false);
    packet.set(chunk, CHUNK_HEADER);
    packets.push(packet);
  }
  return packets;
}

interface PartialMessage {
  count: number;
  parts: Array<Uint8Array | undefined>;
  received: number;
  bytes: number;
  createdAt: number;
}

export interface ReassemblerOptions {
  maxFrameBytes: number;
  timeoutMs?: number;
  maxInflight?: number;
  now?: () => number;
}

/** Bounded reassembly of chunked DataChannel messages. */
export class ChunkReassembler {
  private readonly partials = new Map<number, PartialMessage>();
  private readonly maxFrameBytes: number;
  private readonly timeoutMs: number;
  private readonly maxInflight: number;
  private readonly now: () => number;

  constructor(options: ReassemblerOptions) {
    this.maxFrameBytes = options.maxFrameBytes;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxInflight = options.maxInflight ?? 32;
    this.now = options.now ?? (() => Date.now());
  }

  add(packet: Uint8Array): Uint8Array | null {
    this.expire();
    if (packet.length === 0) return null;
    if (packet[0] === PACKET_SINGLE) {
      const frame = packet.subarray(1);
      return frame.length <= this.maxFrameBytes ? new Uint8Array(frame) : null;
    }
    if (packet[0] !== PACKET_CHUNK || packet.length < CHUNK_HEADER) return null;
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const messageId = view.getUint32(1, false);
    const index = view.getUint16(5, false);
    const count = view.getUint16(7, false);
    if (count === 0 || count > 0xffff || index >= count) return null;
    const payload = packet.subarray(CHUNK_HEADER);
    let partial = this.partials.get(messageId);
    if (!partial) {
      if (this.partials.size >= this.maxInflight) return null;
      partial = {
        count,
        parts: new Array<Uint8Array | undefined>(count),
        received: 0,
        bytes: 0,
        createdAt: this.now(),
      };
      this.partials.set(messageId, partial);
    }
    if (partial.count !== count) {
      this.partials.delete(messageId);
      return null;
    }
    if (partial.parts[index]) return null;
    partial.parts[index] = new Uint8Array(payload);
    partial.received += 1;
    partial.bytes += payload.length;
    if (partial.bytes > this.maxFrameBytes) {
      this.partials.delete(messageId);
      return null;
    }
    if (partial.received !== partial.count) return null;
    this.partials.delete(messageId);
    const parts: Uint8Array[] = [];
    for (const part of partial.parts) {
      if (!part) return null;
      parts.push(part);
    }
    return concatBytes(...parts);
  }

  get inflight(): number {
    return this.partials.size;
  }

  private expire(): void {
    const cutoff = this.now() - this.timeoutMs;
    for (const [id, partial] of this.partials) {
      if (partial.createdAt < cutoff) this.partials.delete(id);
    }
  }
}
