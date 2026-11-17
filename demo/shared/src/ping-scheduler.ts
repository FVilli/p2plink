import type { MeshPingConfig } from "./types.js";

export interface PingSchedulePeer {
  peerId: string;
  lastPingAt: number;
  canPing: boolean;
}

/** Selects every eligible peer that satisfies its per-peer ping spacing. */
export function selectPingPeers(
  now: number,
  config: MeshPingConfig,
  peers: readonly PingSchedulePeer[],
  cursor = 0,
): string[] {
  if (peers.length === 0) return [];
  const selected: string[] = [];
  for (let offset = 0; offset < peers.length; offset += 1) {
    const peer = peers[(cursor + offset) % peers.length]!;
    if (peer.canPing && now - peer.lastPingAt >= config.intervalMs) selected.push(peer.peerId);
  }
  return selected;
}
