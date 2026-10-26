import type { EventContract, RpcContract } from "@p2plink/core";
import { createBrowserWebRtcEngine, type WebRtcEngine } from "@p2plink/webrtc";
import { createNodeWebRtcEngine } from "@p2plink/webrtc/node";
import { P2PLinkClientImpl, type P2PLinkClient } from "./client.js";
import type { P2PLinkClientConfig } from "./config.js";

export function createP2PLinkClient<
  C extends RpcContract = RpcContract,
  E extends EventContract = EventContract,
>(config: P2PLinkClientConfig): P2PLinkClient<C, E> {
  return new P2PLinkClientImpl<C, E>(config, browserEngineFactory);
}

export function createNodeP2PLinkClient<
  C extends RpcContract = RpcContract,
  E extends EventContract = EventContract,
>(config: P2PLinkClientConfig): P2PLinkClient<C, E> {
  return new P2PLinkClientImpl<C, E>(config, nodeEngineFactory);
}

function browserEngineFactory(): WebRtcEngine {
  return createBrowserWebRtcEngine();
}

function nodeEngineFactory(): WebRtcEngine {
  return createNodeWebRtcEngine();
}
