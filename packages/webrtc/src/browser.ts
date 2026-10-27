import type { WebRtcEngine } from "./types.js";
import { createNativeEngine } from "./native-engine.js";

/** Native browser engine (Chrome, Firefox, Safari/WebKit). */
export function createBrowserWebRtcEngine(): WebRtcEngine {
  if (typeof globalThis.RTCPeerConnection === "undefined") {
    throw new Error("WebRTC is not available in this runtime");
  }
  return createNativeEngine("browser", (config) => new globalThis.RTCPeerConnection(config));
}
