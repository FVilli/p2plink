import { Injectable } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import mqtt, { type MqttClient } from "mqtt";
import { config } from "../config.js";

export interface PresenceRecord {
  peerId: string;
  name: string;
  kind: string;
  version: string;
  lastSeen: number;
  traffic: {
    p2p: { tx: TrafficCounters; rx: TrafficCounters };
    mqtt: { tx: TrafficCounters; rx: TrafficCounters };
  };
}

export interface TrafficCounters {
  messages: number;
  bytes: number;
}

function trafficCounters(value: unknown): TrafficCounters {
  if (!value || typeof value !== "object") return { messages: 0, bytes: 0 };
  const counters = value as Record<string, unknown>;
  const valid = (number: unknown) =>
    typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : 0;
  return { messages: valid(counters.messages), bytes: valid(counters.bytes) };
}

function trafficDirection(value: unknown) {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { tx: trafficCounters(record.tx), rx: trafficCounters(record.rx) };
}

function normalizeTraffic(value: unknown): PresenceRecord["traffic"] {
  const traffic = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const legacyP2p = trafficDirection(traffic.p2p);
  const legacyMqtt = trafficDirection(traffic.mqtt);
  return {
    p2p: traffic.p2p
      ? legacyP2p
      : {
          tx: trafficCounters((traffic.tx as Record<string, unknown> | undefined)?.p2p),
          rx: trafficCounters((traffic.rx as Record<string, unknown> | undefined)?.p2p),
        },
    mqtt: traffic.mqtt
      ? legacyMqtt
      : {
          tx: trafficCounters((traffic.tx as Record<string, unknown> | undefined)?.mqtt),
          rx: trafficCounters((traffic.rx as Record<string, unknown> | undefined)?.mqtt),
        },
  };
}

@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly peers = new Map<string, PresenceRecord>();
  private client?: MqttClient;
  private pruneTimer?: ReturnType<typeof setInterval>;

  onModuleInit() {
    if (!config.mqttAdminUrl || !config.mqttAdminUsername || !config.mqttAdminPassword) return;
    this.client = mqtt.connect(config.mqttAdminUrl, {
      username: config.mqttAdminUsername,
      password: config.mqttAdminPassword,
    });
    this.client.on("connect", () =>
      this.client?.subscribe(`${config.meshTopicPrefix}/presence/+`, { qos: 1 }),
    );
    this.client.on("message", (topic, payload) => this.receive(topic, payload.toString()));
    this.pruneTimer = setInterval(() => this.prune(), 5000);
  }

  onModuleDestroy() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.client?.end(true);
  }

  list(): PresenceRecord[] {
    this.prune();
    return [...this.peers.values()].map((peer) => ({ ...peer }));
  }

  count(): number {
    return this.list().length;
  }
  isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  private receive(topic: string, payload: string) {
    const peerId = topic.split("/").at(-1);
    if (!peerId) return;
    if (!payload.trim()) {
      this.peers.delete(peerId);
      return;
    }
    try {
      const record: unknown = JSON.parse(payload);
      if (!record || typeof record !== "object") return;
      const value = record as Record<string, unknown>;
      if (value.peerId === peerId && value.type === "leave") {
        this.peers.delete(peerId);
        return;
      }
      if (value.peerId !== peerId || (value.v !== 1 && value.v !== 2) || value.type !== "presence")
        return;
      if (
        typeof value.name !== "string" ||
        typeof value.kind !== "string" ||
        typeof value.version !== "string" ||
        typeof value.ts !== "number" ||
        !Number.isFinite(value.ts)
      )
        return;
      const lastSeen = value.ts < 1e12 ? value.ts * 1000 : value.ts;
      if (lastSeen < Date.now() - 75_000 || lastSeen > Date.now() + 30_000) return;
      const previous = this.peers.get(peerId);
      if (previous && lastSeen < previous.lastSeen) return;
      this.peers.set(peerId, {
        peerId,
        name: value.name,
        kind: value.kind,
        version: value.version,
        lastSeen,
        traffic: normalizeTraffic(value.traffic),
      });
    } catch {
      /* Ignore malformed broker payloads. */
    }
  }

  private prune() {
    const cutoff = Date.now() - 75_000;
    for (const [peerId, record] of this.peers)
      if (record.lastSeen < cutoff) this.peers.delete(peerId);
  }
}
