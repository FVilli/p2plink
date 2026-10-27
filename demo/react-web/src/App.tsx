import { useEffect, useState } from "react";
import {
  createMeshPeer,
  type MeshIssue,
  type MeshPeer,
  type MeshSnapshot,
  type PeerStats,
} from "@p2plink/demo-mesh";
import { formatByteSize } from "@p2plink/core";
import { createBrowserWebRtcEngine } from "@p2plink/webrtc";

type Config = { url: string; username: string; password: string; name: string };
const KEY = "p2plink-demo-config",
  URL_DEFAULT = "wss://mqtt-ws.fvsg.it:443/ws",
  USER_DEFAULT = "main:rmq-usr";
const runtime = window.__P2PLINK_DEMO_CONFIG__;
const env = import.meta.env;
const runtimeString = (key: string) =>
  typeof runtime?.[key] === "string" ? (runtime[key] as string) : undefined;
const defaultName =
  runtimeString("name") ?? env.VITE_PEER_NAME ?? `browser-${crypto.randomUUID().slice(0, 8)}`;
const pingBytes = Number(runtime?.pingBytes ?? env.VITE_PING_BYTES ?? 2048);
const iceServers = Array.isArray(runtime?.iceServers)
  ? (runtime.iceServers as { urls: string | string[] }[])
  : env.VITE_STUN_URLS
    ? env.VITE_STUN_URLS.split(",").map((url: string) => ({ urls: url.trim() }))
    : [{ urls: "stun:stun.l.google.com:19302" }];
const defaults = (): Config => ({
  url: runtimeString("url") ?? env.VITE_MQTT_URL ?? URL_DEFAULT,
  username: runtimeString("username") ?? env.VITE_MQTT_USERNAME ?? USER_DEFAULT,
  password: runtimeString("password") ?? env.VITE_MQTT_PASSWORD ?? "",
  name: defaultName,
});
function loadConfig(): Config | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    return v &&
      ["url", "username", "password", "name"].every((k) => typeof v[k] === "string" && v[k])
      ? (v as Config)
      : null;
  } catch {
    return null;
  }
}
function ByteSize({ value, rate = false }: { value: number; rate?: boolean }) {
  return (
    <>
      {formatByteSize(value)}
      {rate ? "/s" : ""}
    </>
  );
}
const routeLabel = (route: PeerStats["route"]) =>
  route === "p2p" ? "🟢 p2p" : route === "mqtt" ? "🟡 mqtt" : "⏳ connecting";
const issueContext = (extra: Record<string, string | number | boolean> = {}) => ({
  online: navigator.onLine,
  secureContext: window.isSecureContext,
  pageProtocol: location.protocol,
  userAgent: navigator.userAgent,
  ...extra,
});
export default function App() {
  const [snapshot, setSnapshot] = useState<MeshSnapshot | null>(null);
  const [config, setConfig] = useState<Config>(() => loadConfig() ?? defaults());
  const [editing, setEditing] = useState(
    !loadConfig() &&
      !(runtimeString("url") && runtimeString("username") && runtimeString("password")),
  );
  const [error, setError] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [issues, setIssues] = useState<MeshIssue[]>([]);
  const [peer, setPeer] = useState<MeshPeer | null>(null);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
    };
  }, []);
  useEffect(() => {
    window.__P2PLINK_DEMO_TEST__ = {
      setWebRtcEnabled: (enabled) => peer?.setWebRtcEnabled(enabled),
    };
    return () => {
      delete window.__P2PLINK_DEMO_TEST__;
    };
  }, [peer]);
  useEffect(() => {
    const timer = setInterval(
      () => setIssues((v) => v.filter((i) => Date.now() - i.ts < 60000)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const issue = (name: string, context: Record<string, string | number | boolean>) => {
      const p = peer;
      if (p) void p.reportIssue("error", name, issueContext(context));
    };
    const onError = (e: ErrorEvent) =>
      issue(e.message || "window error", {
        source: "window-error",
        filename: e.filename || "-",
        line: e.lineno || 0,
      });
    const onRejection = (e: PromiseRejectionEvent) =>
      issue("unhandled rejection", {
        source: "promise",
        error: e.reason instanceof Error ? e.reason.message : String(e.reason),
      });
    const onCsp = (e: SecurityPolicyViolationEvent) =>
      issue("security policy violation", {
        source: "csp",
        directive: e.violatedDirective,
        blockedURI: e.blockedURI,
      });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("securitypolicyviolation", onCsp);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("securitypolicyviolation", onCsp);
    };
  }, [peer]);
  async function connect(c: Config) {
    setConfig(c);
    try {
      localStorage.setItem(KEY, JSON.stringify(c));
    } catch {
      /* Storage can be unavailable. */
    }
    const previous = peer;
    setPeer(null);
    if (previous) await previous.stop().catch(() => undefined);
    if (!navigator.onLine) {
      setEditing(false);
      setError("Sei offline. La mesh riprenderà online.");
      return;
    }
    setEditing(false);
    setError("");
    let mesh: MeshPeer;
    try {
      mesh = createMeshPeer({
        url: c.url,
        username: c.username,
        password: c.password,
        name: c.name,
        kind: "browser",
        pingBytes,
        version: __APP_VERSION__,
        platform: navigator.userAgent,
        presenceIntervalMs: 30000,
        engine: createBrowserWebRtcEngine(),
        iceServers,
      });
    } catch (e) {
      setError(`Connessione fallita: ${e instanceof Error ? e.message : String(e)}`);
      setEditing(true);
      return;
    }
    setPeer(mesh);
    mesh.onSnapshot((s) => {
      setSnapshot(s);
      setIssues((current) =>
        [...current.filter((i) => Date.now() - i.ts < 60000), ...s.recentIssues].filter(
          (i, n, a) => a.findIndex((x) => x.ts === i.ts && x.message === i.message) === n,
        ),
      );
    });
    try {
      await mesh.start();
    } catch (e) {
      setError(`Connessione fallita: ${e instanceof Error ? e.message : String(e)}`);
      const u = (() => {
        try {
          return new URL(c.url);
        } catch {
          return null;
        }
      })();
      void mesh.reportIssue(
        "error",
        "browser connect failed",
        issueContext({
          phase: "mesh-start",
          ...(u ? { brokerHost: u.host, brokerProtocol: u.protocol } : {}),
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      setPeer(null);
      await mesh.stop().catch(() => undefined);
      setEditing(navigator.onLine);
    }
  }
  useEffect(() => {
    const stored = loadConfig();
    const rc =
      runtimeString("url") && runtimeString("username") && runtimeString("password")
        ? {
            url: runtimeString("url")!,
            username: runtimeString("username")!,
            password: runtimeString("password")!,
            name: runtimeString("name") ?? defaultName,
          }
        : null;
    const c = rc ?? stored;
    if (c && navigator.onLine) void connect(c);
    return () => {
      void peer?.stop();
    }; // initial connection only
  }, []);
  useEffect(() => {
    const on = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine && !peer) {
        const c = loadConfig() ?? config;
        void connect(c);
      }
    };
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [peer, config]);
  async function openSettings() {
    const previous = peer;
    setPeer(null);
    setSnapshot(null);
    setIssues([]);
    setError("");
    if (previous) await previous.stop().catch(() => undefined);
    setEditing(true);
  }
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    void connect({
      url: String(d.get("url")).trim(),
      username: String(d.get("username")).trim(),
      password: String(d.get("password")),
      name: String(d.get("name")).trim(),
    });
  };
  return (
    <>
      {!online && (
        <div id="offline-banner" className="offline-banner">
          Sei offline: l'app è aperta dalla cache PWA. La mesh riprenderà quando torni online.
        </div>
      )}
      <main>
        <header>
          <div>
            <h1>
              P2PLink Mesh{" "}
              <span id="app-version" className="version">
                v{snapshot?.self.version ?? __APP_VERSION__}
              </span>
            </h1>
            <p>Browser peer network</p>
          </div>
          <span id="broker-state" data-connected={String(snapshot?.brokerConnected ?? false)}>
            {snapshot?.brokerConnected ? "🟢 MQTT" : online ? "🔴 MQTT" : "⚪ MQTT"}
          </span>
        </header>
        <section className="self">
          <div className="self-identity">
            <strong>Self peer</strong>
            <span id="self-peer">
              {snapshot
                ? `${snapshot.self.name} (${snapshot.self.peerId})`
                : peer
                  ? "Starting…"
                  : "Not connected"}
            </span>
          </div>
          <div className="self-actions">
            <button
              id="edit-config"
              className="icon-button"
              title="Impostazioni"
              aria-label="Impostazioni"
              onClick={() => void openSettings()}
            >
              ⚙️
            </button>
            <button
              id="reset-stats"
              className="icon-button"
              title="Reset statistiche"
              aria-label="Reset statistiche"
              onClick={() =>
                window.confirm("Azzerare i contatori e le statistiche di tutti i peer?") &&
                peer?.resetStats()
              }
            >
              ↺
            </button>
          </div>
        </section>
        {editing && (
          <section id="config-panel" className="config">
            <form id="config-form" onSubmit={submit}>
              <h2>Prima connessione</h2>
              <p className="muted">
                I dati vengono salvati solo nel localStorage di questo browser.
              </p>
              <label htmlFor="broker-url">Broker WebSocket URL</label>
              <input
                id="broker-url"
                name="url"
                type="url"
                required
                defaultValue={config.url}
                placeholder={URL_DEFAULT}
              />
              <label htmlFor="broker-username">Username</label>
              <input id="broker-username" name="username" required defaultValue={config.username} />
              <label htmlFor="broker-password">Password</label>
              <input
                id="broker-password"
                name="password"
                type="password"
                required
                defaultValue={config.password}
              />
              <label htmlFor="client-name">Client name</label>
              <input
                id="client-name"
                name="name"
                required
                maxLength={64}
                defaultValue={config.name}
              />
              <p id="config-error" className="config-error">
                {error}
              </p>
              <button type="submit">Connetti</button>
            </form>
          </section>
        )}
        {error && !editing && (
          <div id="error" role="alert">
            {error}
          </div>
        )}
        <section id="totals" className="totals">
          <div className="totals-block">
            <span className="metric-label">👥 Peers</span>
            <strong className="metric-value">{snapshot?.totals.peers ?? 0}</strong>
          </div>
          {(
            [
              ["📤 Outbound", snapshot?.totals.traffic.tx],
              ["📥 Inbound", snapshot?.totals.traffic.rx],
            ] as const
          ).map(([title, t]) => (
            <div className="totals-block" key={title}>
              <span className="metric-label">{title}</span>
              {(["P2P", "MQTT"] as const).map((k) => (
                <div className="traffic-line" key={k}>
                  <span>{k}</span>
                  <strong>{t?.[k.toLowerCase() as "p2p" | "mqtt"].messages ?? 0} msg</strong>
                  <span className="traffic-bytes">
                    <ByteSize value={t?.[k.toLowerCase() as "p2p" | "mqtt"].bytes ?? 0} />
                  </span>
                </div>
              ))}
            </div>
          ))}
        </section>
        <h2 className="section-title">🔗 Connected peers</h2>
        <div className="table-wrap">
          <table id="peers">
            <thead>
              <tr>
                {[
                  "Peer",
                  "Route",
                  "RTT ms",
                  "P2P bytes",
                  "P2P msgs",
                  "MQTT bytes",
                  "MQTT msgs",
                  "P2P B/s",
                  "MQTT B/s",
                  "Pings",
                  "OK",
                  "Last error",
                ].map((x) => (
                  <th key={x}>{x}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snapshot?.peers.map((p) => (
                <tr
                  key={p.peerId}
                  data-peer-id={p.peerId}
                  data-kind={p.kind}
                  data-version={p.version}
                  data-route={p.route}
                  data-rtt={p.rttMs ?? 0}
                  data-p2p-bytes={p.p2pBytes}
                  data-p2p-messages={p.p2pMessages}
                  data-mqtt-bytes={p.mqttBytes}
                  data-mqtt-messages={p.mqttMessages}
                  data-p2p-tx-messages={p.traffic.tx.p2p.messages}
                  data-p2p-rx-messages={p.traffic.rx.p2p.messages}
                  data-mqtt-tx-messages={p.traffic.tx.mqtt.messages}
                  data-mqtt-rx-messages={p.traffic.rx.mqtt.messages}
                  data-p2p-rate={p.p2pBytesPerSec}
                  data-mqtt-rate={p.mqttBytesPerSec}
                  data-pings={p.pings}
                  data-round-trips={p.roundTrips}
                >
                  <td className="peer">
                    <span className="peer-kind">{p.kind === "browser" ? "🌐" : "🖥️"}</span>
                    <strong>{p.name}</strong>
                    <small className="peer-version">{p.version}</small>
                  </td>
                  <td className={`route ${p.route}`}>{routeLabel(p.route)}</td>
                  <td>{p.rttMs?.toFixed(1) ?? "—"}</td>
                  <td>
                    <ByteSize value={p.p2pBytes} />
                  </td>
                  <td>{p.p2pMessages}</td>
                  <td>
                    <ByteSize value={p.mqttBytes} />
                  </td>
                  <td>{p.mqttMessages}</td>
                  <td>
                    <ByteSize value={p.p2pBytesPerSec} rate />
                  </td>
                  <td>
                    <ByteSize value={p.mqttBytesPerSec} rate />
                  </td>
                  <td>{p.pings}</td>
                  <td>{p.roundTrips}</td>
                  <td>{p.lastError ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {issues.length > 0 && (
          <section id="issues" className="issues">
            <h2 className="section-title">🐞 Problemi recenti</h2>
            <ul id="issue-list">
              {issues.slice(0, 12).map((i, n) => (
                <li key={`${i.ts}-${n}`}>
                  {i.level === "error" ? "❌" : "⚠️"} {i.name} v{i.version}: {i.message}{" "}
                  <span className="issue-meta">
                    ({new Date(i.ts).toLocaleTimeString()} {i.peerId}{" "}
                    {Object.entries(i.context)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(" ")}
                    )
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}
