import type { RTCPeerConnection as WeriftPeer, RTCDataChannel as WeriftChannel } from "werift";
import type { IceCandidateInit, SessionDescriptionInit, Unsubscribe } from "@p2plink/core";
import type {
  ChannelState,
  DataChannelLike,
  PeerConnectionLike,
  PeerConnectionState,
  WebRtcEngine,
} from "./types.js";

class WeriftDataChannel implements DataChannelLike {
  private readonly channel: WeriftChannel;

  constructor(channel: WeriftChannel) {
    this.channel = channel;
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
    this.channel.send(Buffer.from(data));
  }

  close(): void {
    this.channel.close();
  }

  onMessage(listener: (data: ArrayBuffer | Uint8Array | string) => void): Unsubscribe {
    const subscription = this.channel.onMessage.subscribe((message) => {
      listener(typeof message === "string" ? message : new Uint8Array(message));
    });
    return () => subscription.unSubscribe();
  }

  onOpen(listener: () => void): Unsubscribe {
    const subscription = this.channel.stateChanged.subscribe((state) => {
      if (state === "open") listener();
    });
    return () => subscription.unSubscribe();
  }

  onClose(listener: () => void): Unsubscribe {
    const subscription = this.channel.stateChanged.subscribe((state) => {
      if (state === "closed") listener();
    });
    return () => subscription.unSubscribe();
  }

  onError(listener: (error: unknown) => void): Unsubscribe {
    const subscription = this.channel.error.subscribe((error) => listener(error));
    return () => subscription.unSubscribe();
  }

  onBufferedAmountLow(listener: () => void): Unsubscribe {
    const subscription = this.channel.bufferedAmountLow.subscribe(() => listener());
    return () => subscription.unSubscribe();
  }

  setBufferedAmountLowThreshold(value: number): void {
    this.channel.bufferedAmountLowThreshold = value;
  }
}

class WeriftPeerConnection implements PeerConnectionLike {
  private readonly peer: WeriftPeer;
  private readonly channels = new Map<WeriftChannel, WeriftDataChannel>();

  constructor(peer: WeriftPeer) {
    this.peer = peer;
  }

  private wrap(channel: WeriftChannel): DataChannelLike {
    let wrapped = this.channels.get(channel);
    if (!wrapped) {
      wrapped = new WeriftDataChannel(channel);
      this.channels.set(channel, wrapped);
    }
    return wrapped;
  }

  createDataChannel(label: string): DataChannelLike {
    return this.wrap(this.peer.createDataChannel(label));
  }

  onDataChannel(listener: (channel: DataChannelLike) => void): Unsubscribe {
    const subscription = this.peer.onDataChannel.subscribe((channel) => {
      listener(this.wrap(channel));
    });
    return () => subscription.unSubscribe();
  }

  async createOffer(): Promise<SessionDescriptionInit> {
    const offer = await this.peer.createOffer();
    return { type: "offer", sdp: offer.sdp };
  }

  async createAnswer(): Promise<SessionDescriptionInit> {
    const answer = await this.peer.createAnswer();
    return { type: "answer", sdp: answer.sdp };
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
    const subscription = this.peer.onIceCandidate.subscribe((candidate) => {
      if (!candidate?.candidate) return;
      listener({
        candidate: candidate.candidate,
        ...(candidate.sdpMid === null || candidate.sdpMid === undefined
          ? {}
          : { sdpMid: candidate.sdpMid }),
        ...(candidate.sdpMLineIndex === null || candidate.sdpMLineIndex === undefined
          ? {}
          : { sdpMLineIndex: candidate.sdpMLineIndex }),
      });
    });
    return () => subscription.unSubscribe();
  }

  onConnectionState(listener: (state: PeerConnectionState) => void): Unsubscribe {
    const subscription = this.peer.connectionStateChange.subscribe((state) => {
      listener(state as PeerConnectionState);
    });
    return () => subscription.unSubscribe();
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

/**
 * Optional pure-TypeScript engine. Prefer `createNodeWebRtcEngine()` unless
 * native prebuilds are unavailable.
 */
export async function createWeriftEngine(): Promise<WebRtcEngine> {
  const { RTCPeerConnection } = await import("werift");
  return {
    name: "werift",
    createPeer(config) {
      return new WeriftPeerConnection(
        new RTCPeerConnection({
          iceServers: config.iceServers.map((server) => ({
            urls: server.urls,
            ...(server.username === undefined ? {} : { username: server.username }),
            ...(server.credential === undefined ? {} : { credential: server.credential }),
          })),
        }),
      );
    },
  };
}
