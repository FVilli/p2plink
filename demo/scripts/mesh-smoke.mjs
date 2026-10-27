import { createMeshPeer } from "../shared/dist/index.js";
import { createNodeWebRtcEngine } from "@p2plink/webrtc/node";

const base = {
  url: "mqtt://127.0.0.1:1884",
  username: "demo",
  password: "demo-pass",
  kind: "nest",
  pingBytes: 2048,
  engine: createNodeWebRtcEngine(),
  pingIntervalMs: 100,
  presenceIntervalMs: 500,
  peerTtlMs: 3000,
};
const a = createMeshPeer({ ...base, name: "smoke-a" });
const b = createMeshPeer({ ...base, name: "smoke-b" });
a.onSnapshot((s) => {
  const p = s.peers[0];
  if (p) console.log("A", s.brokerConnected, p.name, p.route, "p2p", p.p2pBytes, "mqtt", p.mqttBytes, "rtt", p.rttMs, p.lastError ?? "");
});
b.onSnapshot((s) => {
  const p = s.peers[0];
  if (p) console.log("B", s.brokerConnected, p.name, p.route, "p2p", p.p2pBytes, "mqtt", p.mqttBytes, "rtt", p.rttMs, p.lastError ?? "");
});
await a.start();
await b.start();
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  const sa = a.getSnapshot();
  const sb = b.getSnapshot();
  if (sa.peers[0]?.p2pBytes > 0 && sb.peers[0]?.p2pBytes > 0) {
    console.log("SMOKE SUCCESS", JSON.stringify({ a: sa.peers, b: sb.peers }));
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}
await a.stop();
await b.stop();
process.exit(0);
