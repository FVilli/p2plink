import type { EventContract, RpcContract } from "@p2plink/core";
import { createBrowserWebRtcEngine, type WebRtcEngine } from "@p2plink/webrtc";
import { P2PLinkClientImpl, type P2PLinkClient } from "./client.js";
import type { P2PLinkClientConfig } from "./config.js";

/** Browser client. For Node.js import `@p2plink/client/node`. */
export function createP2PLinkClient<
  C extends RpcContract = RpcContract,
  E extends EventContract = EventContract,
>(config: P2PLinkClientConfig): P2PLinkClient<C, E> {
  return new P2PLinkClientImpl<C, E>(config, browserEngineFactory);
}

function browserEngineFactory(): WebRtcEngine {
  return createBrowserWebRtcEngine();
}
