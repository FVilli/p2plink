import {
  createMeshPeer,
  type MeshPeer,
  type MeshSnapshot,
  type PeerStats,
} from "@p2plink/demo-mesh";
import { createBrowserWebRtcEngine } from "@p2plink/webrtc";
import "./style.css";

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
const toggle = byId<HTMLInputElement>("toggle-p2p");
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

const cell = (value: unknown) => {
  const td = document.createElement("td");
  td.textContent = String(value ?? "—");
  return td;
};
const number = (value: number | null) => (value === null ? "—" : value.toFixed(1));

function render(snapshot: MeshSnapshot): void {
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
        cell(p.roundTrips),
        cell(p.lastError),
      );
      return tr;
    }),
  );
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
  toggle.disabled = true;
  editConfigButton.disabled = true;
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
  toggle.disabled = true;
  editConfigButton.disabled = true;
  body.replaceChildren();
  totals.textContent = "";
  broker.dataset.connected = "false";
  broker.textContent = "Broker: disconnected";
  self.textContent = "Not connected";
}

async function connect(config: DemoConfig): Promise<void> {
  await stopPeer();
  currentConfig = config;
  saveConfig(config);
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
    engine: createBrowserWebRtcEngine(),
  });
  peer = mesh;
  mesh.onSnapshot(render);
  toggle.disabled = false;
  editConfigButton.disabled = false;
  try {
    await mesh.start();
  } catch (error) {
    peer = null;
    toggle.disabled = true;
    editConfigButton.disabled = true;
    errorBox.hidden = false;
    errorBox.textContent = `Connessione fallita: ${error instanceof Error ? error.message : String(error)}`;
    showConfigPanel(config, "Connessione fallita. Controlla URL, username e password.");
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

toggle.addEventListener("change", () => peer?.setWebRtcEnabled(toggle.checked));
byId<HTMLButtonElement>("reset-stats").addEventListener("click", () => peer?.resetStats());

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
  void connect(initialConfig);
} else {
  showConfigPanel();
}
