import {
  createMeshPeer,
  type MeshIssue,
  type MeshPeer,
  type MeshSnapshot,
  type PeerStats,
} from "@p2plink/demo-mesh";
import { formatByteSize } from "@p2plink/core";
import {
  DEFAULT_REGISTRY_URL,
  RegistryApi,
  ensureRegistryPeer,
  toFriendlyPeerName,
} from "@p2plink/demo-mesh";
import { createBrowserWebRtcEngine } from "@p2plink/webrtc";
import { registerSW } from "virtual:pwa-register";
import "./style.css";

const APP_VERSION = __APP_VERSION__;
const CONFIG_KEY = "p2plink-demo-config";
const TOKENS_KEY = "p2plink-registry-tokens";
const FRIENDLY_KEY = "p2plink-friendly-name";
const api = new RegistryApi(
  ((window as { __P2PLINK_DEMO_CONFIG__?: Record<string, unknown> }).__P2PLINK_DEMO_CONFIG__
    ?.registryUrl as string) ??
    import.meta.env.VITE_REGISTRY_URL ??
    DEFAULT_REGISTRY_URL,
);

interface DemoConfig {
  url: string;
  username: string;
  password: string;
  name: string;
  clientId?: string;
  peerId?: string;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const broker = byId<HTMLSpanElement>("broker-state");
const self = byId<HTMLSpanElement>("self-peer");
const body = document.querySelector<HTMLTableSectionElement>("#peers tbody")!;
const errorBox = byId<HTMLDivElement>("error");
const totals = byId<HTMLDivElement>("totals");
const brokerDot = byId<HTMLSpanElement>("broker-dot");
const brokerUrlText = byId<HTMLSpanElement>("broker-url");
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
let registryPeerId: string | undefined;
const authPanel = byId<HTMLElement>("auth-panel");
const authForm = byId<HTMLFormElement>("auth-form");
const authEmail = byId<HTMLInputElement>("auth-email");
const authPassword = byId<HTMLInputElement>("auth-password");
const authError = byId<HTMLParagraphElement>("auth-error");
const authFriendly = byId<HTMLInputElement>("auth-friendly");
let authMode: "login" | "register" | "forgot" | "reset" | "verify" | "resend" = "login";
let authToken: string | null = null;
const storedTokens = (): { accessToken: string; refreshToken: string } | null => {
  try {
    return JSON.parse(localStorage.getItem(TOKENS_KEY) || "null");
  } catch {
    return null;
  }
};
const authTitle = byId<HTMLHeadingElement>("auth-title");
const authTokenInput = byId<HTMLInputElement>("auth-token");
const authNewPassword = byId<HTMLInputElement>("auth-new-password");
const authSubmit = byId<HTMLButtonElement>("auth-submit");
function showAuth(message = ""): void {
  authPanel.hidden = false;
  authError.textContent = message;
  const needsToken = authMode === "reset" || authMode === "verify";
  const needsPassword = authMode === "login" || authMode === "register";
  const needsNewPassword = authMode === "reset";
  authTitle.textContent =
    authMode === "login"
      ? "Sign in"
      : authMode === "register"
        ? "Create"
        : authMode === "forgot"
          ? "Forgot"
          : authMode === "resend"
            ? "Resend"
            : authMode === "verify"
              ? "Verify email"
              : "Reset password";
  authSubmit.textContent =
    authMode === "login"
      ? "Sign in"
      : authMode === "register"
        ? "Create"
        : authMode === "forgot"
          ? "Send reset link"
          : authMode === "resend"
            ? "Resend"
            : authMode === "verify"
              ? "Verify email"
              : "Reset password";
  authSubmit.className =
    authMode === "login"
      ? "auth-signin"
      : authMode === "register"
        ? "auth-create"
        : authMode === "forgot"
          ? "auth-forgot"
          : authMode === "resend"
            ? "auth-resend"
            : "auth-reset";
  byId<HTMLLabelElement>("auth-friendly-label").hidden = authMode !== "login";
  authFriendly.hidden = authMode !== "login";
  byId<HTMLLabelElement>("auth-token-label").hidden = !needsToken;
  authTokenInput.hidden = !needsToken;
  byId<HTMLLabelElement>("auth-password-label").hidden = !needsPassword;
  authPassword.hidden = !needsPassword;
  authPassword.required = needsPassword;
  authPassword.minLength = authMode === "register" ? 12 : 1;
  byId<HTMLLabelElement>("auth-new-password-label").hidden = !needsNewPassword;
  authNewPassword.hidden = !needsNewPassword;
  authNewPassword.required = needsNewPassword;
  authNewPassword.minLength = 12;
}
authFriendly.value = localStorage.getItem(FRIENDLY_KEY) ?? defaultName;
const friendlyName = () => toFriendlyPeerName(authFriendly.value || defaultName);
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
const peerCell = (peer: PeerStats): HTMLTableCellElement => {
  const td = document.createElement("td");
  td.className = "peer";
  const kind = document.createElement("span");
  kind.className = "peer-kind";
  kind.textContent = peer.kind === "browser" ? "🌐" : "🖥️";
  const name = document.createElement("strong");
  name.textContent = peer.name;
  const version = document.createElement("small");
  version.className = "peer-version";
  version.textContent = peer.version;
  td.append(kind, name, version);
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
  size.textContent = formatByteSize(bytes);
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
  brokerDot.textContent = snapshot.brokerConnected ? "🟢" : "🔴";
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
        peerCell(p),
        route,
        cell(number(p.rttMs)),
        cell(formatByteSize(p.p2pBytes)),
        p2pMessages,
        cell(formatByteSize(p.mqttBytes)),
        mqttMessages,
        cell(`${formatByteSize(p.p2pBytesPerSec)}/s`),
        cell(`${formatByteSize(p.mqttBytesPerSec)}/s`),
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
      ...(typeof value.clientId === "string" ? { clientId: value.clientId } : {}),
      ...(typeof value.peerId === "string" ? { peerId: value.peerId } : {}),
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

async function stopPeer(): Promise<void> {
  const current = peer;
  peer = null;
  if (current) await current.stop().catch(() => undefined);
  resetButton.disabled = true;
  body.replaceChildren();
  totals.textContent = "";
  broker.dataset.connected = "false";
  brokerDot.textContent = "🔴";
  self.textContent = "Not connected";
}

async function connect(config: DemoConfig): Promise<void> {
  lastConfig = config;
  saveConfig(config);
  await stopPeer();
  if (!navigator.onLine) {
    errorBox.hidden = false;
    errorBox.textContent =
      "Sei offline. La UI resta disponibile dalla cache PWA; la mesh riprenderà online.";
    updateOnlineState();
    return;
  }
  errorBox.hidden = true;
  errorBox.textContent = "";

  brokerUrlText.textContent = config.url;
  const mesh = createMeshPeer({
    url: config.url,
    username: config.username,
    password: config.password,
    name: config.name,
    ...(config.clientId ? { clientId: config.clientId } : {}),
    ...(config.peerId ? { peerId: config.peerId } : {}),
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
  authPanel.hidden = true;
  byId<HTMLButtonElement>("logout").hidden = !authToken;
  resetButton.disabled = false;
  try {
    await mesh.start();
  } catch (error) {
    peer = null;
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
      showAuth("Connessione fallita. Riprova.");
    }
  }
}

function updateOnlineState(): void {
  const offline = !navigator.onLine;
  offlineBanner.hidden = !offline;
  if (offline) {
    broker.dataset.connected = "false";
    brokerDot.textContent = "⚪";
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

byId<HTMLButtonElement>("auth-signin").onclick = () => {
  authMode = "login";
  showAuth();
};
byId<HTMLButtonElement>("auth-register").onclick = () => {
  authMode = "register";
  showAuth();
};
byId<HTMLButtonElement>("auth-forgot").onclick = () => {
  authMode = "forgot";
  showAuth();
};
byId<HTMLButtonElement>("auth-resend").onclick = () => {
  authMode = "resend";
  showAuth();
};
authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authError.textContent = "";
  if (authMode === "login") {
    localStorage.setItem(FRIENDLY_KEY, authFriendly.value.trim() || defaultName);
  }
  try {
    if (authMode === "register") {
      await api.register(authEmail.value, authPassword.value);
      authMode = "verify";
      showAuth("Check your email, then paste the token here.");
      return;
    }
    if (authMode === "forgot") {
      await api.forgotPassword(authEmail.value);
      authMode = "reset";
      showAuth(
        "If the account exists, reset instructions were sent. Paste the token and choose a new password.",
      );
      return;
    }
    if (authMode === "reset") {
      await api.resetPassword(authEmail.value, authTokenInput.value.trim(), authNewPassword.value);
      authMode = "login";
      showAuth("Password updated. Sign in.");
      return;
    }
    if (authMode === "verify") {
      const verified = await api.verifyEmail(authEmail.value, authTokenInput.value.trim());
      localStorage.setItem(TOKENS_KEY, JSON.stringify(verified));
      authToken = verified.accessToken;
      const registered = await ensureRegistryPeer({
        api,
        accessToken: verified.accessToken,
        storage: localStorage,
        name: friendlyName(),
      });
      registryPeerId = registered.peer.peerId;
      await connect({
        ...registered.mqtt,
        name: registered.peer.name,
        peerId: registered.peer.peerId,
      });
      return;
    }
    const tokens = await api.login(authEmail.value, authPassword.value);
    localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
    authToken = tokens.accessToken;
    const registered = await ensureRegistryPeer({
      api,
      accessToken: tokens.accessToken,
      storage: localStorage,
      name: friendlyName(),
    });
    registryPeerId = registered.peer.peerId;
    await connect({
      ...registered.mqtt,
      name: registered.peer.name,
      peerId: registered.peer.peerId,
    });
  } catch (e) {
    authToken = null;
    showAuth(e instanceof Error ? e.message : "Authentication failed");
  }
});
byId<HTMLButtonElement>("logout").onclick = async () => {
  const tokens = storedTokens();
  if (tokens) await api.logout(tokens.refreshToken, registryPeerId).catch(() => undefined);
  localStorage.clear();
  authToken = null;
  registryPeerId = undefined;
  await stopPeer();
  byId<HTMLButtonElement>("logout").hidden = true;
  showAuth();
};
const authParams = new URLSearchParams(location.search);
if (
  authParams.get("auth") === "verify-email" &&
  authParams.get("email") &&
  authParams.get("token")
) {
  void api
    .verifyEmail(authParams.get("email")!, authParams.get("token")!)
    .then(async (tokens) => {
      localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
      authToken = tokens.accessToken;
      const registered = await ensureRegistryPeer({
        api,
        accessToken: tokens.accessToken,
        storage: localStorage,
        name: friendlyName(),
      });
      registryPeerId = registered.peer.peerId;
      history.replaceState({}, "", location.pathname);
      void connect({
        ...registered.mqtt,
        name: registered.peer.name,
        peerId: registered.peer.peerId,
      });
    })
    .catch((e) => showAuth(e instanceof Error ? e.message : "Verification failed"));
} else if (authParams.get("auth") === "reset-password") {
  authMode = "reset";
  const email = authParams.get("email") ?? "";
  authEmail.value = email;
  authTokenInput.value = authParams.get("token") ?? "";
  showAuth("Choose a new password.");
}
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
if (authParams.has("auth")) {
  if (authParams.get("auth") === "reset-password") {
    showAuth("Choose a new password.");
  } else if (authParams.get("auth") === "verify-email") {
    showAuth("Confirm your email token.");
  }
} else if (initialConfig) {
  lastConfig = initialConfig;
  if (navigator.onLine) void connect(initialConfig);
  else {
    updateOnlineState();
    errorBox.hidden = false;
    errorBox.textContent =
      "Sei offline. La UI è disponibile dalla cache PWA; la mesh riprenderà quando torni online.";
  }
} else if (authParams.get("auth") === "verify-email") {
  authMode = "verify";
  authEmail.value = authParams.get("email") ?? "";
  authTokenInput.value = authParams.get("token") ?? "";
  showAuth("Confirm your email token.");
} else if (storedTokens() && !authParams.has("auth")) {
  const tokens = storedTokens()!;
  authToken = tokens.accessToken;
  void ensureRegistryPeer({
    api,
    accessToken: tokens.accessToken,
    storage: localStorage,
    name: friendlyName(),
  })
    .then((registered) => {
      registryPeerId = registered.peer.peerId;
      void connect({
        ...registered.mqtt,
        name: registered.peer.name,
        peerId: registered.peer.peerId,
      });
    })
    .catch(() => {
      localStorage.removeItem(TOKENS_KEY);
      authToken = null;
      showAuth("Please sign in again.");
    });
} else if (!authParams.has("auth")) {
  showAuth();
}
updateOnlineState();

try {
  registerSW({ immediate: true });
} catch {
  // Service worker is optional; the app remains usable online.
}
