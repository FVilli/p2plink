import type { TransportKind } from "@p2plink/core";
import type { TrafficCount, TrafficView } from "./types.js";

interface Sample {
  at: number;
  p2p: number;
  mqtt: number;
}

const emptyCount = (): TrafficCount => ({ messages: 0, bytes: 0 });

export const emptyTraffic = (): TrafficView => ({
  tx: { p2p: emptyCount(), mqtt: emptyCount() },
  rx: { p2p: emptyCount(), mqtt: emptyCount() },
});

export function cloneTraffic(traffic: TrafficView): TrafficView {
  return {
    tx: {
      p2p: { ...traffic.tx.p2p },
      mqtt: { ...traffic.tx.mqtt },
    },
    rx: {
      p2p: { ...traffic.rx.p2p },
      mqtt: { ...traffic.rx.mqtt },
    },
  };
}

export function addTraffic(target: TrafficView, source: TrafficView): void {
  for (const direction of ["tx", "rx"] as const) {
    for (const kind of ["p2p", "mqtt"] as const) {
      target[direction][kind].messages += source[direction][kind].messages;
      target[direction][kind].bytes += source[direction][kind].bytes;
    }
  }
}

export interface RateSnapshot {
  p2pBytes: number;
  mqttBytes: number;
  p2pMessages: number;
  mqttMessages: number;
  p2pBytesPerSec: number;
  mqttBytesPerSec: number;
  traffic: TrafficView;
}

/** Lifetime message/byte counters with a sliding-window byte rate. */
export class RateMeter {
  private traffic = emptyTraffic();
  private samples: Sample[] = [];
  private readonly windowMs: number;

  constructor(windowMs = 2_000) {
    this.windowMs = windowMs;
  }

  addTx(transport: TransportKind, bytes: number): void {
    this.add(transport, bytes, "tx");
  }

  addRx(transport: TransportKind, bytes: number): void {
    this.add(transport, bytes, "rx");
  }

  private add(transport: TransportKind, bytes: number, direction: "tx" | "rx"): void {
    const kind = transport === "webrtc" ? "p2p" : "mqtt";
    const count = this.traffic[direction][kind];
    count.messages += 1;
    count.bytes += Math.max(0, bytes);
    this.samples.push({
      at: Date.now(),
      p2p: this.traffic.tx.p2p.bytes + this.traffic.rx.p2p.bytes,
      mqtt: this.traffic.tx.mqtt.bytes + this.traffic.rx.mqtt.bytes,
    });
    const cutoff = Date.now() - this.windowMs * 3;
    while (this.samples.length > 0 && this.samples[0]!.at < cutoff) this.samples.shift();
  }

  reset(): void {
    this.traffic = emptyTraffic();
    this.samples = [];
  }

  snapshot(now = Date.now()): RateSnapshot {
    const cutoff = now - this.windowMs;
    const p2pBytes = this.traffic.tx.p2p.bytes + this.traffic.rx.p2p.bytes;
    const mqttBytes = this.traffic.tx.mqtt.bytes + this.traffic.rx.mqtt.bytes;
    let baseline: Sample | undefined;
    for (const sample of this.samples) {
      if (sample.at >= cutoff) {
        baseline = sample;
        break;
      }
    }
    const base = baseline ?? { at: now, p2p: p2pBytes, mqtt: mqttBytes };
    const elapsed = Math.max(500, now - base.at);
    return {
      p2pBytes,
      mqttBytes,
      p2pMessages: this.traffic.tx.p2p.messages + this.traffic.rx.p2p.messages,
      mqttMessages: this.traffic.tx.mqtt.messages + this.traffic.rx.mqtt.messages,
      p2pBytesPerSec: Math.max(0, Math.round(((p2pBytes - base.p2p) / elapsed) * 1000)),
      mqttBytesPerSec: Math.max(0, Math.round(((mqttBytes - base.mqtt) / elapsed) * 1000)),
      traffic: cloneTraffic(this.traffic),
    };
  }
}
