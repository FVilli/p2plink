import {
  createMeshPeer,
  type MeshIssue,
  type MeshPeer,
  type MeshSnapshot,
  type PeerStats,
} from "@p2plink/demo-mesh";
import { createBrowserWebRtcEngine } from "@p2plink/webrtc";
import { registerSW } from "virtual:pwa-register";
import "./style.css";

const APP_VERSION = __APP_VERSION__;
const CONFIG_KEY = "p2plink-demo-config";
const DEFAULT_URL = "wss://mqtt-ws.fvsg.it:443/ws";
const DEFAULT_USERNAME = "main:rmq-usr";

interface DemoConfig {
  url: string;
  username: string;
  password: string;
  name: string;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const broker = byId<HTMLSpanElement>("broker-state");
const self = byId<HTMLSpanElement>("self-peer");
const body = document.querySelector<HTMLTableSectionElement>("#peers tbody")!;
const errorBox = byId<HTMLDivElement>("error");
const totals = byId<HTMLDivElement>("totals");
const configPanel = byId<HTMLElement>("config-panel");
const configForm = byId<HTMLFormElement>("config-form");
const urlInput = byId<HTMLInputElement>("broker-url");
const usernameInput = byId<HTMLInputElement>("broker-username");
const passwordInput = byId<HTMLInputElement>("broker-password");
const nameInput = byId<HTMLInputElement>("client-name");
const configError = byId<HTMLParagraphElement>("config-error");
const editConfigButton = byId<HTMLButtonElement>("edit-config");
const resetButton = byId<HTMLButtonElement>("reset-stats");
const offlineBanner = byId<HTMLDivElement>("offline-banner");
const appVersion = byId<HTMLSpanElement>("app-version");
const issuesSection = byId<HTMLElement>("issues");
const issueList = byId<HTMLUListElement>("issue-list");
appVersion.textContent = `v${APP_VERSION}`;

const env = import.meta.env;
const randomId = crypto.randomUUID().slice(0, 8);
const runtime = (window as { __P2PLINK_DEMO_CONFIG__?: Record<string, unknown> })
  .__P2PLINK_DEMO_CONFIG__;
const runtimeString = (key: string): string | undefined =>
  typeof runtime?.[key] === "string" ? (runtime[key] as string) : undefined;
const defaultName = runtimeString("name") ?? env.VITE_PEER_NAME ?? `browser-${randomId}`;
const pingBytes = Number(runtime?.pingBytes ?? env.VITE_PING_BYTES ?? 2048);
const runtimeIce = Array.isArray(runtime?.iceServers)
  ? (runtime.iceServers as { urls: string | string[] }[])
  : null;
const iceServers =
  runtimeIce ??
  (env.VITE_STUN_URLS
    ? env.VITE_STUN_URLS.split(",").map((url: string) => ({ urls: url.trim() }))
    : [{ urls: "stun:stun.l.google.com:19302" }]);

let peer: MeshPeer | null = null;
let currentConfig: DemoConfig | null = null;
let lastConfig: DemoConfig | null = null;

// Test/debug hook: the visible P2P toggle was removed from the UI.
(
  window as typeof window & {
    __P2PLINK_DEMO_TEST__?: { setWebRtcEnabled: (enabled: boolean) => void };
  }
).__P2PLINK_DEMO_TEST__ = {
  setWebRtcEnabled: (enabled) => peer?.setWebRtcEnabled(enabled),
};

const cell = (value: unknown) => {
  const td = document.createElement("td");
  td.textContent = String(value ?? "—");
  return td;
};
const number = (value: number | null) => (value === null ? "—" : value.toFixed(1));
const ISSUE_TTL_MS = 60_000;
const routeLabel = (route: PeerStats["route"]) =>
  route === "p2p" ? "🟢 p2p" : route === "mqtt" ? "🟡 mqtt" : "⏳ connecting";
const issueContext = (extra: Record<string, string | number | boolean> = {}) => ({
  online: navigator.onLine,
  secureContext: window.isSecureContext,
  pageProtocol: location.protocol,
  userAgent: navigator.userAgent,
  ...extra,
});

function renderIssues(allIssues: MeshIssue[]): void {
  const now = Date.now();
  const issues = allIssues.filter((issue) => now - issue.ts < ISSUE_TTL_MS);
  issuesSection.hidden = issues.length === 0;
  issueList.replaceChildren(
    ...issues.slice(0, 12).map((issue) => {
      const item = document.createElement("li");
      const level = document.createElement("span");
      level.className = `issue-${issue.level}`;
      level.textContent = issue.level === "error" ? "❌" : "⚠️";
      const text = document.createElement("span");
      text.textContent = ` ${issue.name} v${issue.version}: ${issue.message}`;
      const meta = document.createElement("span");
      meta.className = "issue-meta";
      const context = Object.entries(issue.context)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");
      meta.textContent = ` (${new Date(issue.ts).toLocaleTimeString()} ${issue.peerId}${context ? ` ${context}` : ""})`;
      item.append(level, text, meta);
      return item;
    }),
  );
}

function trafficLine(label: string, messages: number, bytes: number): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "traffic-line";
  const name = document.createElement("span");
  name.textContent = label;
  const count = document.createElement("strong");
  count.textContent = `${messages} msg`;
  const size = document.createElement("span");
  size.className = "traffic-bytes";
  size.textContent = `${bytes} B`;
  line.append(name, count, size);
  return line;
}

function totalsBlock(label: string): { block: HTMLDivElement; value: HTMLElement } {
  const block = document.createElement("div");
  block.className = "totals-block";
  const heading = document.createElement("span");
  heading.className = "metric-label";
  heading.textContent = label;
  const value = document.createElement("div");
  block.append(heading, value);
  return { block, value };
}

function renderTotals(snapshot: MeshSnapshot): void {
  const peers = totalsBlock("👥 Peers");
  const peersValue = document.createElement("strong");
  peersValue.className = "metric-value";
  peersValue.textContent = String(snapshot.totals.peers);
  peers.value.append(peersValue);

  const outbound = totalsBlock("📤 Outbound");
  outbound.value.append(
    trafficLine(
      "P2P",
      snapshot.totals.traffic.tx.p2p.messages,
      snapshot.totals.traffic.tx.p2p.bytes,
    ),
    trafficLine(
      "MQTT",
      snapshot.totals.traffic.tx.mqtt.messages,
      snapshot.totals.traffic.tx.mqtt.bytes,
    ),
  );

  const inbound = totalsBlock("📥 Inbound");
  inbound.value.append(
    trafficLine(
      "P2P",
      snapshot.totals.traffic.rx.p2p.messages,
      snapshot.totals.traffic.rx.p2p.bytes,
    ),
    trafficLine(
      "MQTT",
      snapshot.totals.traffic.rx.mqtt.messages,
      snapshot.totals.traffic.rx.mqtt.bytes,
    ),
  );

  totals.replaceChildren(peers.block, outbound.block, inbound.block);
}

function render(snapshot: MeshSnapshot): void {
  broker.dataset.connected = String(snapshot.brokerConnected);
  broker.textContent = snapshot.brokerConnected ? "🟢 MQTT" : "🔴 MQTT";
  self.textContent = `${snapshot.self.name} (${snapshot.self.peerId})`;
  appVersion.textContent = `v${snapshot.self.version}`;
  renderTotals(snapshot);
  body.replaceChildren(
    ...snapshot.peers.map((p: PeerStats) => {
      const tr = document.createElement("tr");
      tr.dataset.peerId = p.peerId;
      tr.dataset.kind = p.kind;
      tr.dataset.version = p.version;
      tr.dataset.route = p.route;
      tr.dataset.rtt = String(p.rttMs ?? 0);
      tr.dataset.p2pBytes = String(p.p2pBytes);
      tr.dataset.p2pMessages = String(p.p2pMessages);
      tr.dataset.mqttBytes = String(p.mqttBytes);
      tr.dataset.mqttMessages = String(p.mqttMessages);
      tr.dataset.p2pTxMessages = String(p.traffic.tx.p2p.messages);
      tr.dataset.p2pRxMessages = String(p.traffic.rx.p2p.messages);
      tr.dataset.mqttTxMessages = String(p.traffic.tx.mqtt.messages);
      tr.dataset.mqttRxMessages = String(p.traffic.rx.mqtt.messages);
      tr.dataset.p2pRate = String(p.p2pBytesPerSec);
      tr.dataset.mqttRate = String(p.mqttBytesPerSec);
      tr.dataset.pings = String(p.pings);
      tr.dataset.roundTrips = String(p.roundTrips);
      const route = cell(routeLabel(p.route));
      route.className = `route ${p.route}`;
      const p2pMessages = cell(p.p2pMessages);
      p2pMessages.title = `tx ${p.traffic.tx.p2p.messages} / rx ${p.traffic.rx.p2p.messages}${
        p.remoteTraffic
          ? ` · peer reports tx ${p.remoteTraffic.tx.p2p.messages} / rx ${p.remoteTraffic.rx.p2p.messages}`
          : ""
      }`;
      const mqttMessages = cell(p.mqttMessages);
      mqttMessages.title = `tx ${p.traffic.tx.mqtt.messages} / rx ${p.traffic.rx.mqtt.messages}${
        p.remoteTraffic
          ? ` · peer reports tx ${p.remoteTraffic.tx.mqtt.messages} / rx ${p.remoteTraffic.rx.mqtt.messages}`
          : ""
      }`;
      tr.append(
        cell(p.name),
        cell(p.version),
        cell(p.kind),
        route,
        cell(number(p.rttMs)),
        cell(p.p2pBytes),
        p2pMessages,
        cell(p.mqttBytes),
        mqttMessages,
        cell(number(p.p2pBytesPerSec)),
        cell(number(p.mqttBytesPerSec)),
        cell(p.pings),
        cell(p.roundTrips),
        cell(p.lastError),
      );
      return tr;
    }),
  );
  renderIssues(snapshot.recentIssues);
}

function loadStoredConfig(): DemoConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<DemoConfig>;
    if (
      typeof value.url !== "string" ||
      typeof value.username !== "string" ||
      typeof value.password !== "string" ||
      typeof value.name !== "string" ||
      !value.url ||
      !value.username ||
      !value.password ||
      !value.name
    ) {
      return null;
    }
    return {
      url: value.url,
      username: value.username,
      password: value.password,
      name: value.name,
    };
  } catch {
    return null;
  }
}

function saveConfig(config: DemoConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Private browsing/storage disabled: keep the session in memory.
  }
}

function fillForm(config: DemoConfig): void {
  urlInput.value = config.url;
  usernameInput.value = config.username;
  passwordInput.value = config.password;
  nameInput.value = config.name;
}

function showConfigPanel(config?: DemoConfig | null, message?: string): void {
  const initial = config ?? {
    url: runtimeString("url") ?? env.VITE_MQTT_URL ?? DEFAULT_URL,
    username: runtimeString("username") ?? env.VITE_MQTT_USERNAME ?? DEFAULT_USERNAME,
    password: runtimeString("password") ?? env.VITE_MQTT_PASSWORD ?? "",
    name: defaultName,
  };
  fillForm(initial);
  configPanel.hidden = false;
  configError.textContent = message ?? "";
  editConfigButton.disabled = true;
  resetButton.disabled = true;
  usernameInput.focus();
}

function readForm(): DemoConfig | null {
  const url = urlInput.value.trim();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  const name = nameInput.value.trim();
  if (!url || !username || !password || !name) {
    configError.textContent = "URL, username, password e client name sono obbligatori.";
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error("protocol");
    }
  } catch {
    configError.textContent = "L'URL deve essere un URL WebSocket ws:// o wss:// valido.";
    return null;
  }
  return { url, username, password, name };
}

async function stopPeer(): Promise<void> {
  const current = peer;
  peer = null;
  if (current) await current.stop().catch(() => undefined);
  editConfigButton.disabled = true;
  resetButton.disabled = true;
  body.replaceChildren();
  totals.textContent = "";
  broker.dataset.connected = "false";
  broker.textContent = "🔴 MQTT";
  self.textContent = "Not connected";
}

async function connect(config: DemoConfig): Promise<void> {
  lastConfig = config;
  currentConfig = config;
  saveConfig(config);
  await stopPeer();
  if (!navigator.onLine) {
    configPanel.hidden = true;
    errorBox.hidden = false;
    errorBox.textContent =
      "Sei offline. La UI resta disponibile dalla cache PWA; la mesh riprenderà online.";
    updateOnlineState();
    return;
  }
  configPanel.hidden = true;
  configError.textContent = "";
  errorBox.hidden = true;
  errorBox.textContent = "";

  const mesh = createMeshPeer({
    url: config.url,
    username: config.username,
    password: config.password,
    name: config.name,
    kind: "browser",
    pingBytes,
    iceServers,
    version: APP_VERSION,
    platform: navigator.userAgent,
    presenceIntervalMs: 30_000,
    engine: createBrowserWebRtcEngine(),
  });
  peer = mesh;
  mesh.onSnapshot(render);
  editConfigButton.disabled = false;
  resetButton.disabled = false;
  try {
    await mesh.start();
  } catch (error) {
    peer = null;
    editConfigButton.disabled = true;
    resetButton.disabled = true;
    errorBox.hidden = false;
    errorBox.textContent = `Connessione fallita: ${error instanceof Error ? error.message : String(error)}`;
    void mesh.reportIssue(
      "error",
      "browser connect failed",
      issueContext({
        phase: "mesh-start",
        brokerHost: new URL(config.url).host,
        brokerProtocol: new URL(config.url).protocol,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    if (!navigator.onLine) {
      updateOnlineState();
    } else {
      showConfigPanel(config, "Connessione fallita. Controlla URL, username e password.");
    }
  }
}

configForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const config = readForm();
  if (config) void connect(config);
});

editConfigButton.addEventListener("click", () => {
  const config = currentConfig;
  void stopPeer().then(() => {
    showConfigPanel(config, "");
  });
});

function updateOnlineState(): void {
  const offline = !navigator.onLine;
  offlineBanner.hidden = !offline;
  if (offline) {
    broker.dataset.connected = "false";
    broker.textContent = "⚪ MQTT";
  }
}

window.addEventListener("online", () => {
  updateOnlineState();
  if (lastConfig && !peer) void connect(lastConfig);
});
window.addEventListener("offline", () => {
  updateOnlineState();
});

window.addEventListener("error", (event) => {
  peer?.reportIssue(
    "error",
    event.message || "window error",
    issueContext({
      source: "window-error",
      filename: event.filename || "-",
      line: event.lineno || 0,
    }),
  );
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  peer?.reportIssue(
    "error",
    "unhandled rejection",
    issueContext({ source: "promise", error: reason }),
  );
});
window.addEventListener("securitypolicyviolation", (event) => {
  peer?.reportIssue(
    "error",
    "security policy violation",
    issueContext({
      source: "csp",
      directive: event.violatedDirective,
      blockedURI: event.blockedURI,
    }),
  );
});

resetButton.addEventListener("click", () => {
  if (!peer) return;
  if (window.confirm("Azzerare i contatori e le statistiche di tutti i peer?")) {
    peer.resetStats();
  }
});

const runtimeConfig: DemoConfig | null =
  runtimeString("url") && runtimeString("username") && runtimeString("password")
    ? {
        url: runtimeString("url")!,
        username: runtimeString("username")!,
        password: runtimeString("password")!,
        name: runtimeString("name") ?? defaultName,
      }
    : null;
const initialConfig = runtimeConfig ?? loadStoredConfig();
if (initialConfig) {
  lastConfig = initialConfig;
  if (navigator.onLine) void connect(initialConfig);
  else {
    updateOnlineState();
    errorBox.hidden = false;
    errorBox.textContent =
      "Sei offline. La UI è disponibile dalla cache PWA; la mesh riprenderà quando torni online.";
  }
} else {
  showConfigPanel();
}
updateOnlineState();

try {
  registerSW({ immediate: true });
} catch {
  // Service worker is optional; the app remains usable online.
}
