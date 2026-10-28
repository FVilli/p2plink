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
      if (value.peerId !== peerId || value.v !== 1 || value.type !== "presence") return;
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
