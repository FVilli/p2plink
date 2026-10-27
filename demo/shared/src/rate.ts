import type { TransportKind } from "@p2plink/core";

interface Sample {
  at: number;
  p2p: number;
  mqtt: number;
}

export interface RateSnapshot {
  p2pBytes: number;
  mqttBytes: number;
  p2pBytesPerSec: number;
  mqttBytesPerSec: number;
}

/** Sliding-window byte/rate counter used by the demo table. */
export class RateMeter {
  private p2p = 0;
  private mqtt = 0;
  private samples: Sample[] = [];
  private readonly windowMs: number;

  constructor(windowMs = 2_000) {
    this.windowMs = windowMs;
  }

  add(transport: TransportKind, bytes: number): void {
    if (bytes <= 0) return;
    if (transport === "webrtc") this.p2p += bytes;
    else this.mqtt += bytes;
    const now = Date.now();
    this.samples.push({ at: now, p2p: this.p2p, mqtt: this.mqtt });
    const cutoff = now - this.windowMs * 3;
    while (this.samples.length > 0 && this.samples[0]!.at < cutoff) this.samples.shift();
  }

  reset(): void {
    this.p2p = 0;
    this.mqtt = 0;
    this.samples = [];
  }

  snapshot(now = Date.now()): RateSnapshot {
    const cutoff = now - this.windowMs;
    let baseline: Sample | undefined;
    for (const sample of this.samples) {
      if (sample.at >= cutoff) {
        baseline = sample;
        break;
      }
    }
    const base = baseline ?? { at: now, p2p: this.p2p, mqtt: this.mqtt };
    const elapsed = Math.max(1, now - base.at);
    return {
      p2pBytes: this.p2p,
      mqttBytes: this.mqtt,
      p2pBytesPerSec: Math.max(0, Math.round(((this.p2p - base.p2p) / elapsed) * 1000)),
      mqttBytesPerSec: Math.max(0, Math.round(((this.mqtt - base.mqtt) / elapsed) * 1000)),
    };
  }
}
