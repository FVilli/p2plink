import { Injectable, Logger } from "@nestjs/common";
import type { OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { formatByteSize } from "@p2plink/core";
import { createMeshPeer, type MeshSnapshot } from "@p2plink/demo-mesh";
import { createNodeWebRtcEngine } from "@p2plink/webrtc/node";

@Injectable()
export class MeshService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MeshService.name);
  private readonly peer = createMeshPeer({
    url: process.env.MQTT_URL ?? "mqtts://mqtt.fvsg.it:8883",
    username: process.env.MQTT_USERNAME ?? "main:rmq-usr",
    password: process.env.MQTT_PASSWORD ?? "",
    name: process.env.PEER_NAME ?? `nest-${crypto.randomUUID().slice(0, 6)}`,
    kind: "nest",
    version: process.env.APP_VERSION ?? "0.2.1",
    platform: `${process.platform}/${process.arch}`,
    presenceIntervalMs: (() => {
      const configured = Number(process.env.PRESENCE_INTERVAL_MS ?? 30_000);
      return Number.isFinite(configured) && configured >= 1_000 ? configured : 30_000;
    })(),
    pingBytes: Number(process.env.PING_BYTES ?? 2048),
    iceServers:
      process.env.STUN_URLS === ""
        ? []
        : (process.env.STUN_URLS ?? "stun:stun.l.google.com:19302")
            .split(",")
            .map((url) => ({ urls: url.trim() })),
    engine: createNodeWebRtcEngine(),
    disableWebRtc: process.env.WEBRTC_ENABLED === "false",
  });
  private timer: NodeJS.Timeout | undefined;
  private snapshot: MeshSnapshot = this.peer.getSnapshot();

  async onModuleInit(): Promise<void> {
    this.peer.onSnapshot((snapshot) => {
      this.snapshot = snapshot;
    });
    await this.peer.start();
    this.timer = setInterval(() => this.printStats(), 1000);
    this.printStats();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.peer.stop();
  }

  getSnapshot(): MeshSnapshot {
    return this.snapshot;
  }

  private printStats(): void {
    const snapshot = this.snapshot;
    if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
    const header = [
      "PEER",
      "VER",
      "KIND",
      "ROUTE",
      "RTT",
      "P2P_B",
      "P2P_M",
      "MQTT_B",
      "MQTT_M",
      "P2P_B/s",
      "MQTT_B/s",
      "PINGS",
      "OK",
      "ERROR",
    ];
    const rows = snapshot.peers.map((peer) => [
      peer.name,
      peer.version,
      peer.kind,
      peer.route,
      peer.rttMs === null ? "-" : `${peer.rttMs}ms`,
      formatByteSize(peer.p2pBytes),
      String(peer.p2pMessages),
      formatByteSize(peer.mqttBytes),
      String(peer.mqttMessages),
      `${formatByteSize(peer.p2pBytesPerSec)}/s`,
      `${formatByteSize(peer.mqttBytesPerSec)}/s`,
      String(peer.pings),
      String(peer.roundTrips),
      peer.lastError ?? "-",
    ]);
    const widths = header.map((value, index) =>
      Math.max(value.length, ...rows.map((row) => (row[index] ?? "").length)),
    );
    const line = (row: string[]) =>
      row.map((value, index) => String(value).padEnd(widths[index] ?? 0)).join("  ");
    const issues = snapshot.recentIssues
      .slice(0, 3)
      .map(
        (issue) =>
          `ISSUE ${issue.level.toUpperCase()} ${issue.name} v${issue.version} (${issue.peerId}): ${issue.message} ${JSON.stringify(issue.context)}`,
      )
      .join("\n");
    this.logger.log(
      `broker=${snapshot.brokerConnected ? "connected" : "disconnected"} self=${snapshot.self.name} v${snapshot.self.version} (${snapshot.self.peerId}) peers=${snapshot.totals.peers}\n` +
        `${line(header)}\n${rows.length ? rows.map(line).join("\n") : "(no peers)"}` +
        (issues ? `\n${issues}` : ""),
    );
  }
}
