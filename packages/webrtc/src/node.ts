import { RTCPeerConnection as NodePeerConnection } from "node-datachannel/polyfill";
import type { WebRtcEngine } from "./types.js";
import { createNativeEngine } from "./native-engine.js";

/**
 * Node.js engine backed by node-datachannel (libdatachannel prebuilds).
 * This entry must only be imported in Node.js code.
 */
export function createNodeWebRtcEngine(): WebRtcEngine {
  return createNativeEngine("node-datachannel", (config) => {
    return new NodePeerConnection(config) as unknown as globalThis.RTCPeerConnection;
  });
}

export { createWeriftEngine } from "./werift.js";
export type { WebRtcEngine } from "./types.js";
