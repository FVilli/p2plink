import {
  P2PLinkError,
  P2PLinkErrorCodes,
  noopLogger,
  utf8Encode,
  type IceCandidateInit,
  type IceServer,
  type Logger,
  type SignalPayload,
  type Transport,
  type TransportKind,
  type TransportState,
  type Unsubscribe,
} from "@p2plink/core";
import { ChunkReassembler, encodeTransportPackets } from "./chunking.js";
import type {
  DataChannelLike,
  PeerConnectionLike,
  PeerConnectionState,
  WebRtcEngine,
} from "./types.js";

export interface WebRtcTransportOptions {
  engine: WebRtcEngine;
  role: "offerer" | "answerer";
  negotiationId: string;
  epoch: number;
  iceServers?: IceServer[];
  label?: string;
  sendSignal(signal: SignalPayload): Promise<void>;
  maxFrameBytes?: number;
  chunkSize?: number;
  highWaterMark?: number;
  lowWaterMark?: number;
  maxQueuedBytes?: number;
  drainTimeoutMs?: number;
  logger?: Logger;
}

/**
 * One WebRTC negotiation. The client is always the offerer, which avoids
 * glare. Renegotiation creates a new instance with a higher epoch.
 */
export class WebRtcTransport implements Transport {
  readonly kind: TransportKind = "webrtc";
  readonly negotiationId: string;
  readonly epoch: number;

  private readonly options: WebRtcTransportOptions;
  private readonly logger: Logger;
  private readonly maxFrameBytes: number;
  private readonly chunkSize: number;
  private readonly highWaterMark: number;
  private readonly lowWaterMark: number;
  private readonly maxQueuedBytes: number;
  private readonly drainTimeoutMs: number;
  private readonly reassembler: ChunkReassembler;
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly stateListeners = new Set<(state: TransportState) => void>();
  private readonly cleanups: Unsubscribe[] = [];
  private readonly remoteCandidates: IceCandidateInit[] = [];
  private peer: PeerConnectionLike | null = null;
  private channel: DataChannelLike | null = null;
  private remoteDescriptionSet = false;
  private _state: TransportState = "connecting";
  private sendChain: Promise<unknown> = Promise.resolve();
  private queuedBytes = 0;
  private nextMessageId = 1;
  private closed = false;

  constructor(options: WebRtcTransportOptions) {
    this.options = options;
    this.negotiationId = options.negotiationId;
    this.epoch = options.epoch;
    this.logger = options.logger ?? noopLogger;
    this.maxFrameBytes = options.maxFrameBytes ?? 256 * 1024;
    this.chunkSize = options.chunkSize ?? 12_000;
    this.highWaterMark = options.highWaterMark ?? 1024 * 1024;
    this.lowWaterMark = options.lowWaterMark ?? 256 * 1024;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 8 * 1024 * 1024;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 5_000;
    this.reassembler = new ChunkReassembler({ maxFrameBytes: this.maxFrameBytes });
  }

  get state(): TransportState {
    return this._state;
  }

  async start(): Promise<void> {
    if (this.options.role !== "offerer") {
      throw new P2PLinkError(
        P2PLinkErrorCodes.INVALID_CONFIG,
        "Only the offerer can start a negotiation",
      );
    }
    const peer = this.createPeer();
    const channel = peer.createDataChannel(this.options.label ?? "p2plink");
    this.attachChannel(channel);
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await this.options.sendSignal({
        kind: "offer",
        negotiationId: this.negotiationId,
        epoch: this.epoch,
        sdp: offer,
      });
    } catch (error) {
      this.fail(error);
      throw P2PLinkError.from(error);
    }
  }

  async handleSignal(signal: SignalPayload): Promise<void> {
    if (signal.negotiationId !== this.negotiationId || signal.epoch !== this.epoch) {
      this.logger.debug("ignoring stale signaling", {
        negotiationId: signal.negotiationId,
        epoch: signal.epoch,
      });
      return;
    }
    if (this.closed) return;
    try {
      switch (signal.kind) {
        case "offer": {
          if (this.options.role !== "answerer") return;
          this.resetPeer();
          const peer = this.createPeer();
          await peer.setRemoteDescription(signal.sdp);
          this.remoteDescriptionSet = true;
          await this.flushRemoteCandidates(peer);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          await this.options.sendSignal({
            kind: "answer",
            negotiationId: this.negotiationId,
            epoch: this.epoch,
            sdp: answer,
          });
          break;
        }
        case "answer": {
          if (this.options.role !== "offerer" || !this.peer || this.remoteDescriptionSet) return;
          await this.peer.setRemoteDescription(signal.sdp);
          this.remoteDescriptionSet = true;
          await this.flushRemoteCandidates(this.peer);
          break;
        }
        case "ice": {
          if (!this.peer || !this.remoteDescriptionSet) {
            if (this.remoteCandidates.length >= 128) this.remoteCandidates.shift();
            this.remoteCandidates.push(signal.candidate);
          } else {
            await this.peer.addIceCandidate(signal.candidate);
          }
          break;
        }
        case "bye":
          await this.close();
          break;
      }
    } catch (error) {
      this.fail(error);
    }
  }

  send(data: Uint8Array): Promise<void> {
    if (this._state !== "open" || !this.channel) {
      return Promise.reject(
        new P2PLinkError(P2PLinkErrorCodes.TRANSPORT_UNAVAILABLE, "WebRTC transport is not open", {
          retryable: true,
        }),
      );
    }
    if (data.length > this.maxFrameBytes) {
      return Promise.reject(
        new P2PLinkError(P2PLinkErrorCodes.PAYLOAD_TOO_LARGE, "Frame too large"),
      );
    }
    if (this.queuedBytes + data.length > this.maxQueuedBytes) {
      return Promise.reject(
        new P2PLinkError(P2PLinkErrorCodes.RATE_LIMITED, "WebRTC send queue is full", {
          retryable: true,
        }),
      );
    }
    this.queuedBytes += data.length;
    const task = this.sendChain.then(() => this.sendInternal(data));
    this.sendChain = task
      .catch(() => undefined)
      .finally(() => {
        this.queuedBytes -= data.length;
      });
    return task;
  }

  onData(listener: (data: Uint8Array) => void): Unsubscribe {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onStateChange(listener: (state: TransportState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async close(reason = "closed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.logger.debug("webrtc transport closing", { reason, negotiationId: this.negotiationId });
    this.disposePeer();
    this.setState("closed");
    this.dataListeners.clear();
    this.stateListeners.clear();
  }

  private createPeer(): PeerConnectionLike {
    const peer = this.options.engine.createPeer({
      iceServers: this.options.iceServers ?? [],
    });
    this.peer = peer;
    this.cleanups.push(
      peer.onIceCandidate((candidate) => {
        void this.options
          .sendSignal({
            kind: "ice",
            negotiationId: this.negotiationId,
            epoch: this.epoch,
            candidate,
          })
          .catch((error: unknown) => {
            this.logger.debug("failed to send ICE candidate", {
              error: P2PLinkError.from(error).message,
            });
          });
      }),
      peer.onDataChannel((channel) => this.attachChannel(channel)),
      peer.onConnectionState((state) => this.handlePeerState(state)),
    );
    return peer;
  }

  private attachChannel(channel: DataChannelLike): void {
    if (this.channel && this.channel !== channel) {
      try {
        this.channel.close();
      } catch {
        // Ignore.
      }
    }
    this.channel = channel;
    channel.setBufferedAmountLowThreshold(this.lowWaterMark);
    this.cleanups.push(
      channel.onOpen(() => {
        this.logger.info("webrtc data channel open", { negotiationId: this.negotiationId });
        this.setState("open");
      }),
      channel.onClose(() => {
        if (!this.closed) {
          this.logger.warn("webrtc data channel closed", { negotiationId: this.negotiationId });
          this.setState("closed");
        }
      }),
      channel.onError((error) => {
        this.logger.warn("webrtc data channel error", {
          negotiationId: this.negotiationId,
          error: P2PLinkError.from(error).message,
        });
      }),
      channel.onMessage((data) => this.handleMessage(data)),
    );
  }

  private handleMessage(data: ArrayBuffer | Uint8Array | string): void {
    const bytes = normalize(data);
    if (!bytes) {
      this.logger.warn("ignoring non-binary WebRTC message");
      return;
    }
    let frame: Uint8Array | null;
    try {
      frame = this.reassembler.add(bytes);
    } catch (error) {
      this.logger.warn("failed to reassemble frame", {
        error: P2PLinkError.from(error).message,
      });
      return;
    }
    if (!frame) return;
    for (const listener of this.dataListeners) {
      try {
        listener(frame);
      } catch (error) {
        this.logger.error("webrtc data listener failed", {
          error: P2PLinkError.from(error).message,
        });
      }
    }
  }

  private async sendInternal(frame: Uint8Array): Promise<void> {
    const channel = this.channel;
    if (!channel || this._state !== "open") {
      throw new P2PLinkError(P2PLinkErrorCodes.TRANSPORT_UNAVAILABLE, "WebRTC channel closed");
    }
    const packets = encodeTransportPackets(frame, this.chunkSize, this.nextMessageId);
    this.nextMessageId = (this.nextMessageId + 1) >>> 0;
    for (const packet of packets) {
      await this.waitForDrain(channel);
      try {
        channel.send(packet);
      } catch (error) {
        this.fail(error);
        throw new P2PLinkError(P2PLinkErrorCodes.TRANSPORT_SEND_FAILED, "DataChannel send failed", {
          retryable: true,
          outcomeUnknown: true,
          cause: error,
        });
      }
    }
  }

  private async waitForDrain(channel: DataChannelLike): Promise<void> {
    if (channel.bufferedAmount <= this.highWaterMark) return;
    const deadline = Date.now() + this.drainTimeoutMs;
    while (channel.bufferedAmount > this.lowWaterMark) {
      if (Date.now() > deadline) {
        throw new P2PLinkError(
          P2PLinkErrorCodes.RATE_LIMITED,
          "Timed out waiting for DataChannel backpressure to drain",
          { retryable: true },
        );
      }
      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          unsubscribe();
          clearTimeout(timer);
          resolve();
        };
        const unsubscribe = channel.onBufferedAmountLow(finish);
        const timer = setTimeout(finish, 25);
      });
    }
  }

  private async flushRemoteCandidates(peer: PeerConnectionLike): Promise<void> {
    const candidates = this.remoteCandidates.splice(0);
    for (const candidate of candidates) {
      try {
        await peer.addIceCandidate(candidate);
      } catch (error) {
        this.logger.debug("failed to add queued ICE candidate", {
          error: P2PLinkError.from(error).message,
        });
      }
    }
  }

  private handlePeerState(state: PeerConnectionState): void {
    this.logger.debug("webrtc peer state", { state, negotiationId: this.negotiationId });
    if (state === "failed") {
      this.fail(new P2PLinkError(P2PLinkErrorCodes.TRANSPORT_UNAVAILABLE, "WebRTC failed"));
    } else if (state === "closed") {
      this.close("peer-closed");
    }
  }

  private resetPeer(): void {
    this.disposePeer();
    this.remoteDescriptionSet = false;
    this.remoteCandidates.length = 0;
    this.setState("connecting");
  }

  private disposePeer(): void {
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Ignore.
      }
    }
    try {
      this.channel?.close();
    } catch {
      // Ignore.
    }
    try {
      this.peer?.close();
    } catch {
      // Ignore.
    }
    this.channel = null;
    this.peer = null;
    this.remoteDescriptionSet = false;
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.logger.warn("webrtc transport failed", {
      negotiationId: this.negotiationId,
      error: P2PLinkError.from(error).message,
    });
    this.closed = true;
    this.disposePeer();
    this.setState("failed");
  }

  private setState(state: TransportState): void {
    if (this._state === state) return;
    this._state = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // Ignore.
      }
    }
  }
}

function normalize(data: ArrayBuffer | Uint8Array | string): Uint8Array | null {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string") return utf8Encode(data);
  return null;
}
