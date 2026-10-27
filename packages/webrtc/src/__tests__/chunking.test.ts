import { describe, expect, it } from "vitest";
import { randomBytes } from "@p2plink/core";
import { ChunkReassembler, encodeTransportPackets } from "../chunking.js";

describe("DataChannel chunking", () => {
  it("splits and reassembles large frames out of order", () => {
    const frame = randomBytes(30_000);
    const packets = encodeTransportPackets(frame, 4_096, 7);
    expect(packets.length).toBeGreaterThan(1);

    const reassembler = new ChunkReassembler({ maxFrameBytes: 64 * 1024 });
    let result: Uint8Array | null = null;
    for (const packet of [...packets].reverse()) {
      result = reassembler.add(packet) ?? result;
    }
    expect(result).not.toBeNull();
    expect(Buffer.from(result!).equals(Buffer.from(frame))).toBe(true);
  });

  it("passes through small frames", () => {
    const frame = new Uint8Array([1, 2, 3, 4]);
    const packets = encodeTransportPackets(frame, 1024, 1);
    expect(packets).toHaveLength(1);
    const reassembler = new ChunkReassembler({ maxFrameBytes: 1024 });
    expect(Array.from(reassembler.add(packets[0]!) ?? [])).toEqual([1, 2, 3, 4]);
  });

  it("rejects oversized and timed-out partial messages", () => {
    let now = 0;
    const reassembler = new ChunkReassembler({
      maxFrameBytes: 10,
      timeoutMs: 100,
      now: () => now,
    });
    const packets = encodeTransportPackets(randomBytes(100), 10, 2);
    for (const packet of packets.slice(0, -1)) reassembler.add(packet);
    now = 1_000;
    for (const packet of packets) reassembler.add(packet);
    expect(reassembler.inflight).toBe(0);
  });
});
