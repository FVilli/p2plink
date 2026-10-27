import type {
  IceCandidateInit,
  IceServer,
  SessionDescriptionInit,
  Unsubscribe,
} from "@p2plink/core";
import type {
  ChannelState,
  DataChannelLike,
  PeerConnectionLike,
  PeerConnectionState,
  WebRtcEngine,
} from "./types.js";

type NativePeer = globalThis.RTCPeerConnection;
type NativeChannel = globalThis.RTCDataChannel;

function toIceServers(servers: IceServer[]): RTCIceServer[] {
  return servers.map((server) => ({
    urls: server.urls,
    ...(server.username === undefined ? {} : { username: server.username }),
    ...(server.credential === undefined ? {} : { credential: server.credential }),
  }));
}

class NativeDataChannel implements DataChannelLike {
  private readonly channel: NativeChannel;

  constructor(channel: NativeChannel) {
    this.channel = channel;
    try {
      channel.binaryType = "arraybuffer";
    } catch {
      // Some implementations keep Buffer semantics.
    }
  }

  get label(): string {
    return this.channel.label;
  }

  get readyState(): ChannelState {
    return this.channel.readyState;
  }

  get bufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  send(data: Uint8Array): void {
    this.channel.send(data as unknown as ArrayBuffer);
  }

  close(): void {
    this.channel.close();
  }

  onMessage(listener: (data: ArrayBuffer | Uint8Array | string) => void): Unsubscribe {
    const handler = (event: MessageEvent): void => {
      listener(event.data as ArrayBuffer | Uint8Array | string);
    };
    this.channel.addEventListener("message", handler);
    return () => this.channel.removeEventListener("message", handler);
  }

  onOpen(listener: () => void): Unsubscribe {
    this.channel.addEventListener("open", listener);
    return () => this.channel.removeEventListener("open", listener);
  }

  onClose(listener: () => void): Unsubscribe {
    this.channel.addEventListener("close", listener);
    return () => this.channel.removeEventListener("close", listener);
  }

  onError(listener: (error: unknown) => void): Unsubscribe {
    const handler = (event: Event): void => listener(event);
    this.channel.addEventListener("error", handler);
    return () => this.channel.removeEventListener("error", handler);
  }

  onBufferedAmountLow(listener: () => void): Unsubscribe {
    const handler = (): void => listener();
    this.channel.addEventListener("bufferedamountlow", handler);
    return () => this.channel.removeEventListener("bufferedamountlow", handler);
  }

  setBufferedAmountLowThreshold(value: number): void {
    try {
      this.channel.bufferedAmountLowThreshold = value;
    } catch {
      // Unsupported; the transport falls back to polling bufferedAmount.
    }
  }
}

class NativePeerConnection implements PeerConnectionLike {
  private readonly peer: NativePeer;

  constructor(peer: NativePeer) {
    this.peer = peer;
  }

  createDataChannel(label: string): DataChannelLike {
    return new NativeDataChannel(this.peer.createDataChannel(label, { ordered: true }));
  }

  onDataChannel(listener: (channel: DataChannelLike) => void): Unsubscribe {
    const handler = (event: RTCDataChannelEvent): void =>
      listener(new NativeDataChannel(event.channel));
    this.peer.addEventListener("datachannel", handler);
    return () => this.peer.removeEventListener("datachannel", handler);
  }

  async createOffer(): Promise<SessionDescriptionInit> {
    const offer = await this.peer.createOffer();
    return { type: "offer", sdp: offer.sdp ?? "" };
  }

  async createAnswer(): Promise<SessionDescriptionInit> {
    const answer = await this.peer.createAnswer();
    return { type: "answer", sdp: answer.sdp ?? "" };
  }

  async setLocalDescription(description: SessionDescriptionInit): Promise<void> {
    await this.peer.setLocalDescription(description);
  }

  async setRemoteDescription(description: SessionDescriptionInit): Promise<void> {
    await this.peer.setRemoteDescription(description);
  }

  async addIceCandidate(candidate: IceCandidateInit): Promise<void> {
    await this.peer.addIceCandidate(candidate);
  }

  onIceCandidate(listener: (candidate: IceCandidateInit) => void): Unsubscribe {
    const handler = (event: RTCPeerConnectionIceEvent): void => {
      if (!event.candidate?.candidate) return;
      listener({
        candidate: event.candidate.candidate,
        ...(event.candidate.sdpMid === null ? {} : { sdpMid: event.candidate.sdpMid }),
        ...(event.candidate.sdpMLineIndex === null
          ? {}
          : { sdpMLineIndex: event.candidate.sdpMLineIndex }),
        ...(event.candidate.usernameFragment === null
          ? {}
          : { usernameFragment: event.candidate.usernameFragment }),
      });
    };
    this.peer.addEventListener("icecandidate", handler);
    return () => this.peer.removeEventListener("icecandidate", handler);
  }

  onConnectionState(listener: (state: PeerConnectionState) => void): Unsubscribe {
    const handler = (): void => listener(this.peer.connectionState as PeerConnectionState);
    this.peer.addEventListener("connectionstatechange", handler);
    return () => this.peer.removeEventListener("connectionstatechange", handler);
  }

  localDescription(): SessionDescriptionInit | null {
    const description = this.peer.localDescription;
    if (!description?.sdp) return null;
    return { type: description.type as "offer" | "answer", sdp: description.sdp };
  }

  close(): void {
    this.peer.close();
  }
}

/** Engine factory for browsers and for polyfills exposing the W3C API. */
export function createNativeEngine(
  name: string,
  factory: (config: { iceServers: RTCIceServer[] }) => NativePeer,
): WebRtcEngine {
  return {
    name,
    createPeer(config) {
      return new NativePeerConnection(factory({ iceServers: toIceServers(config.iceServers) }));
    },
  };
}

export { toIceServers };
