import {
  P2PLinkError,
  P2PLinkErrorCodes,
  concatBytes,
  equalBytes,
  fromBase64Url,
  toBase64Url,
  type TransportKind,
} from "@p2plink/core";
import type { DerivedSession, DirectionalKeys } from "./handshake.js";
import { ReplayWindow } from "./replay.js";
import { randomBytes, utf8Encode } from "./encoding.js";

export const FRAME_MAGIC = 0x02;
export const FRAME_VERSION = 1;
const HEADER_BYTES = 22;
const IV_BYTES = 12;
const PREFIX_BYTES = 4;
const MAX_SEQUENCE = 2 ** 48;

export interface FrameCipherOptions {
  sendKey: CryptoKey;
  receiveKey: CryptoKey;
  sessionId: string;
  transport: TransportKind;
  maxFrameBytes?: number;
  replayWindow?: number;
  /** Test hook; production frames carry a fresh random prefix. */
  ivPrefix?: Uint8Array;
}

/**
 * AES-256-GCM frame protection. Nonces are `prefix || 64-bit counter`; the
 * counter is authenticated as AAD and never reset for a given key. Inbound
 * frames are serialized so replay checks and decryption cannot race.
 */
export class FrameCipher {
  private readonly sendKey: CryptoKey;
  private readonly receiveKey: CryptoKey;
  private readonly sessionId: string;
  private readonly transport: TransportKind;
  private readonly maxFrameBytes: number;
  private readonly replay: ReplayWindow;
  private readonly ivPrefix: Uint8Array;
  private sendCounter = 0;
  private expectedReceivePrefix: Uint8Array | null = null;
  private openChain: Promise<unknown> = Promise.resolve();
  private destroyed = false;

  constructor(options: FrameCipherOptions) {
    this.sendKey = options.sendKey;
    this.receiveKey = options.receiveKey;
    this.sessionId = options.sessionId;
    this.transport = options.transport;
    this.maxFrameBytes = options.maxFrameBytes ?? 512 * 1024;
    this.replay = new ReplayWindow(options.replayWindow ?? 1024);
    this.ivPrefix = options.ivPrefix ? new Uint8Array(options.ivPrefix) : randomBytes(PREFIX_BYTES);
    if (this.ivPrefix.length !== PREFIX_BYTES) {
      throw new P2PLinkError(P2PLinkErrorCodes.INVALID_CONFIG, "IV prefix must be 4 bytes");
    }
  }

  async seal(plaintext: Uint8Array): Promise<Uint8Array> {
    if (this.destroyed) {
      throw new P2PLinkError(P2PLinkErrorCodes.CLOSED, "Session cipher is closed");
    }
    if (this.sendCounter >= MAX_SEQUENCE) {
      throw new P2PLinkError(
        P2PLinkErrorCodes.KEY_EXHAUSTED,
        "Frame counter exhausted; renegotiate the session",
      );
    }
    const sequence = this.sendCounter;
    this.sendCounter += 1;
    const iv = buildIv(this.ivPrefix, sequence);
    const aad = buildAad(this.transport, this.sessionId, sequence);
    const ciphertext = new Uint8Array(
      await globalThis.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
        this.sendKey,
        plaintext as BufferSource,
      ),
    );
    const frame = new Uint8Array(HEADER_BYTES + ciphertext.length);
    frame[0] = FRAME_MAGIC;
    frame[1] = FRAME_VERSION;
    writeUint64(frame, 2, sequence);
    frame.set(iv, 10);
    frame.set(ciphertext, HEADER_BYTES);
    if (frame.length > this.maxFrameBytes) {
      throw new P2PLinkError(
        P2PLinkErrorCodes.PAYLOAD_TOO_LARGE,
        `Frame is ${frame.length} bytes, limit is ${this.maxFrameBytes}`,
      );
    }
    return frame;
  }

  open(frame: Uint8Array): Promise<Uint8Array> {
    const run = this.openChain.then(() => this.openInternal(frame));
    this.openChain = run.catch(() => undefined);
    return run;
  }

  private async openInternal(frame: Uint8Array): Promise<Uint8Array> {
    if (this.destroyed) {
      throw new P2PLinkError(P2PLinkErrorCodes.CLOSED, "Session cipher is closed");
    }
    if (frame.length < HEADER_BYTES + 16) {
      throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Frame too short");
    }
    if (frame.length > this.maxFrameBytes) {
      throw new P2PLinkError(P2PLinkErrorCodes.PAYLOAD_TOO_LARGE, "Frame too large");
    }
    if (frame[0] !== FRAME_MAGIC || frame[1] !== FRAME_VERSION) {
      throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Unsupported frame version");
    }
    const sequence = readUint64(frame, 2);
    if (sequence > MAX_SEQUENCE) {
      throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Frame counter out of range");
    }
    const iv = frame.subarray(10, 10 + IV_BYTES);
    if (!equalBytes(iv.subarray(0, PREFIX_BYTES), this.ivPrefixForReceive(frame))) {
      throw new P2PLinkError(P2PLinkErrorCodes.REPLAY_DETECTED, "Unexpected IV prefix");
    }
    if (!this.replay.check(sequence)) {
      throw new P2PLinkError(P2PLinkErrorCodes.REPLAY_DETECTED, "Replayed or stale frame");
    }
    const aad = buildAad(this.transport, this.sessionId, sequence);
    let plaintext: Uint8Array;
    try {
      plaintext = new Uint8Array(
        await globalThis.crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: iv as BufferSource,
            additionalData: aad as BufferSource,
            tagLength: 128,
          },
          this.receiveKey,
          frame.subarray(HEADER_BYTES) as BufferSource,
        ),
      );
    } catch (error) {
      throw new P2PLinkError(P2PLinkErrorCodes.DECRYPT_FAILED, "Frame authentication failed", {
        cause: error,
      });
    }
    this.replay.commit(sequence);
    if (this.expectedReceivePrefix === null) {
      this.expectedReceivePrefix = new Uint8Array(iv.subarray(0, PREFIX_BYTES));
    }
    return plaintext;
  }

  private ivPrefixForReceive(frame: Uint8Array): Uint8Array {
    if (this.expectedReceivePrefix !== null) return this.expectedReceivePrefix;
    // First frame: accept its IV prefix provisionally; it is committed only
    // after successful authentication.
    return frame.subarray(10, 10 + PREFIX_BYTES);
  }

  destroy(): void {
    this.destroyed = true;
    this.expectedReceivePrefix = null;
    this.openChain = Promise.resolve();
  }
}

export interface TransportSecurityOptions {
  maxFrameBytes?: number;
  replayWindow?: number;
}

/** Binds the role (client/server) to the correct directional keys. */
export class TransportSecurity {
  readonly sessionId: string;
  private readonly ciphers: Record<TransportKind, FrameCipher>;
  private destroyed = false;

  constructor(
    session: DerivedSession,
    role: "client" | "server",
    options: TransportSecurityOptions = {},
  ) {
    this.sessionId = session.sessionId;
    this.ciphers = {
      mqtt: makeCipher("mqtt", session, role, options),
      webrtc: makeCipher("webrtc", session, role, options),
    };
  }

  async seal(transport: TransportKind, plaintext: Uint8Array): Promise<Uint8Array> {
    if (this.destroyed) {
      throw new P2PLinkError(P2PLinkErrorCodes.CLOSED, "Session security is closed");
    }
    return this.ciphers[transport].seal(plaintext);
  }

  async open(transport: TransportKind, frame: Uint8Array): Promise<Uint8Array> {
    if (this.destroyed) {
      throw new P2PLinkError(P2PLinkErrorCodes.CLOSED, "Session security is closed");
    }
    return this.ciphers[transport].open(frame);
  }

  destroy(): void {
    this.destroyed = true;
    this.ciphers.mqtt.destroy();
    this.ciphers.webrtc.destroy();
  }
}

function makeCipher(
  transport: TransportKind,
  session: DerivedSession,
  role: "client" | "server",
  options: TransportSecurityOptions,
): FrameCipher {
  const keys: DirectionalKeys = session.keys[transport];
  return new FrameCipher({
    sendKey: role === "client" ? keys.c2s : keys.s2c,
    receiveKey: role === "client" ? keys.s2c : keys.c2s,
    sessionId: session.sessionId,
    transport,
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    ...(options.replayWindow === undefined ? {} : { replayWindow: options.replayWindow }),
  });
}

function buildAad(transport: TransportKind, sessionId: string, sequence: number): Uint8Array {
  return utf8Encode(`p2plink/v1|${transport}|${sessionId}|${sequence}`);
}

function buildIv(prefix: Uint8Array, sequence: number): Uint8Array {
  const iv = new Uint8Array(IV_BYTES);
  iv.set(prefix, 0);
  writeUint64(iv, PREFIX_BYTES, sequence);
  return iv;
}

function writeUint64(target: Uint8Array, offset: number, value: number): void {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  view.setBigUint64(offset, BigInt(value), false);
}

function readUint64(source: Uint8Array, offset: number): number {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  return Number(view.getBigUint64(offset, false));
}
