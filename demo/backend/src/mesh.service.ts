import { Injectable, Logger } from "@nestjs/common";
import type { OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { createMeshPeer, type MeshSnapshot } from "@p2plink/demo-mesh";
import { createNodeWebRtcEngine } from "@p2plink/webrtc/node";

@Injectable()
export class MeshService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MeshService.name);
  private readonly peer = createMeshPeer({
    url: process.env.MQTT_URL ?? "mqtt://127.0.0.1:1884",
    ...(process.env.MQTT_USERNAME ? { username: process.env.MQTT_USERNAME } : {}),
    ...(process.env.MQTT_PASSWORD ? { password: process.env.MQTT_PASSWORD } : {}),
    name: process.env.PEER_NAME ?? `nest-${crypto.randomUUID().slice(0, 6)}`,
    kind: "nest",
    pingBytes: Number(process.env.PING_BYTES ?? 2048),
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
      "KIND",
      "ROUTE",
      "RTT",
      "P2P_B",
      "MQTT_B",
      "P2P_B/s",
      "MQTT_B/s",
      "PINGS",
      "ERROR",
    ];
    const rows = snapshot.peers.map((peer) => [
      peer.name,
      peer.kind,
      peer.route,
      peer.rttMs === null ? "-" : `${peer.rttMs}ms`,
      String(peer.p2pBytes),
      String(peer.mqttBytes),
      String(peer.p2pBytesPerSec),
      String(peer.mqttBytesPerSec),
      String(peer.pings),
      String(peer.roundTrips),
      peer.lastError ?? "-",
    ]);
    const widths = header.map((value, index) =>
      Math.max(value.length, ...rows.map((row) => (row[index] ?? "").length)),
    );
    const line = (row: string[]) =>
      row.map((value, index) => String(value).padEnd(widths[index] ?? 0)).join("  ");
    this.logger.log(
      `broker=${snapshot.brokerConnected ? "connected" : "disconnected"} self=${snapshot.self.name} (${snapshot.self.peerId}) peers=${snapshot.totals.peers}\n` +
        `${line(header)}\n${rows.length ? rows.map(line).join("\n") : "(no peers)"}`,
    );
  }
}
