import { createMeshPeer, type MeshSnapshot, type PeerStats } from "@p2plink/demo-mesh";
import { createBrowserWebRtcEngine } from "@p2plink/webrtc";
import "./style.css";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const broker = byId<HTMLSpanElement>("broker-state");
const self = byId<HTMLSpanElement>("self-peer");
const toggle = byId<HTMLInputElement>("toggle-p2p");
const body = document.querySelector<HTMLTableSectionElement>("#peers tbody")!;
const errorBox = byId<HTMLDivElement>("error");
const totals = byId<HTMLDivElement>("totals");
const env = import.meta.env;
const randomId = crypto.randomUUID().slice(0, 8);
const config = {
  url: env.VITE_MQTT_URL || "ws://127.0.0.1:9002",
  username: env.VITE_MQTT_USERNAME || "demo",
  password: env.VITE_MQTT_PASSWORD || "demo-pass",
  name: env.VITE_PEER_NAME || `browser-${randomId}`,
  kind: "browser" as const,
  pingBytes: Number(env.VITE_PING_BYTES || 2048),
  engine: createBrowserWebRtcEngine(),
};
const peer = createMeshPeer(config);
const cell = (value: unknown) => {
  const td = document.createElement("td");
  td.textContent = String(value ?? "—");
  return td;
};
const number = (value: number | null) => (value === null ? "—" : value.toFixed(1));
function render(snapshot: MeshSnapshot) {
  broker.dataset.connected = String(snapshot.brokerConnected);
  broker.textContent = `Broker: ${snapshot.brokerConnected ? "connected" : "disconnected"}`;
  self.textContent = `${snapshot.self.name} (${snapshot.self.peerId})`;
  toggle.checked = snapshot.webRtcEnabled;
  totals.innerHTML = `<span>Peers: ${snapshot.totals.peers}</span><span>P2P: ${snapshot.totals.p2pBytes} B (${number(snapshot.totals.p2pBytesPerSec)} B/s)</span><span>MQTT: ${snapshot.totals.mqttBytes} B (${number(snapshot.totals.mqttBytesPerSec)} B/s)</span>`;
  body.replaceChildren(
    ...snapshot.peers.map((p: PeerStats) => {
      const tr = document.createElement("tr");
      tr.dataset.peerId = p.peerId;
      tr.dataset.kind = p.kind;
      tr.dataset.route = p.route;
      tr.dataset.rtt = String(p.rttMs ?? 0);
      tr.dataset.p2pBytes = String(p.p2pBytes);
      tr.dataset.mqttBytes = String(p.mqttBytes);
      tr.dataset.p2pRate = String(p.p2pBytesPerSec);
      tr.dataset.mqttRate = String(p.mqttBytesPerSec);
      tr.dataset.pings = String(p.pings);
      tr.dataset.roundTrips = String(p.roundTrips);
      const route = cell(p.route);
      route.className = `route ${p.route}`;
      tr.append(
        cell(p.name),
        cell(p.kind),
        route,
        cell(number(p.rttMs)),
        cell(p.p2pBytes),
        cell(p.mqttBytes),
        cell(number(p.p2pBytesPerSec)),
        cell(number(p.mqttBytesPerSec)),
        cell(p.pings),
        cell(p.lastError),
      );
      return tr;
    }),
  );
}
peer.onSnapshot(render);
toggle.addEventListener("change", () => peer.setWebRtcEnabled(toggle.checked));
byId<HTMLButtonElement>("reset-stats").addEventListener("click", () => peer.resetStats());
void peer.start().catch((error: unknown) => {
  errorBox.hidden = false;
  errorBox.textContent = `Startup error: ${error instanceof Error ? error.message : String(error)}`;
});
