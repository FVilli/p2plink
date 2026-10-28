import { Component, signal, Pipe, PipeTransform, isDevMode } from "@angular/core";
import { DatePipe } from "@angular/common";
import { bootstrapApplication } from "@angular/platform-browser";
import { provideServiceWorker } from "@angular/service-worker";
import { ByteSizePipe } from "@p2plink/angular";
import {
  createMeshPeer,
  type MeshPeer,
  type MeshSnapshot,
  type PeerStats,
  RegistryApi,
  ensureRegistryPeer,
  type RegistryTokens,
} from "@p2plink/demo-mesh";
import { createBrowserWebRtcEngine } from "@p2plink/webrtc";

const VERSION = "0.2.1",
  KEY = "p2plink-demo-config",
  TOKENS_KEY = "p2plink-registry-tokens",
  REGISTRY_URL = "https://p2plink-registry.fvsg.mqu.it",
  DEFAULT_URL = "wss://mqtt-ws.fvsg.it:443/ws",
  DEFAULT_USERNAME = "main:rmq-usr";
type Config = {
  url: string;
  username: string;
  password: string;
  name: string;
  clientId?: string;
  peerId?: string;
};
interface DemoRuntime {
  url?: unknown;
  username?: unknown;
  password?: unknown;
  name?: unknown;
  pingBytes?: unknown;
  iceServers?: { urls: string | string[] }[];
  [key: string]: unknown;
}
interface DemoWindow extends Window {
  __P2PLINK_DEMO_CONFIG__?: DemoRuntime;
  __P2PLINK_DEMO_TEST__?: { setWebRtcEnabled(enabled: boolean): void };
}
const demoWindow = window as DemoWindow;
const appEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
@Pipe({ name: "bytesRate", standalone: true })
class BytesRatePipe implements PipeTransform {
  transform(n: number): string {
    return `${new ByteSizePipe().transform(n)}/s`;
  }
}
@Component({
  selector: "app-root",
  standalone: true,
  imports: [ByteSizePipe, BytesRatePipe, DatePipe],
  template: ` <div id="offline-banner" class="offline-banner" [hidden]="online()">
      Sei offline: l'app è aperta dalla cache PWA. La mesh riprenderà quando torni online.
    </div>
    <main>
      <header>
        <div>
          <h1>
            P2PLink Mesh <span id="app-version" class="version">v{{ version }}</span>
          </h1>
          <p>Browser peer network</p>
        </div>
        <span id="broker-state" [attr.data-connected]="connected()">{{
          connected() ? "🟢 MQTT" : online() ? "🔴 MQTT" : "⚪ MQTT"
        }}</span>
      </header>
      <section class="self">
        <div class="self-identity">
          <strong>Self peer</strong><span id="self-peer">{{ identity() }}</span>
        </div>
        <div class="self-actions">
          <button
            id="edit-config"
            class="icon-button"
            aria-label="Impostazioni"
            title="Impostazioni"
            (click)="openSettings()"
          >
            ⚙️
          </button>
          <button
            id="logout"
            class="icon-button"
            aria-label="Logout"
            title="Logout"
            [hidden]="!registrySession()"
            (click)="logout()"
          >
            ⇥
          </button>
          <button
            id="reset-stats"
            class="icon-button"
            aria-label="Reset statistiche"
            title="Reset statistiche"
            (click)="reset()"
          >
            ↺
          </button>
        </div>
      </section>
      <section id="auth-panel" class="config" [hidden]="!authVisible()">
        <form (submit)="authSubmit($event)">
          <h2>{{ authMode() }}</h2>
          <p class="muted">P2PLink Registry account</p>
          <label>Email</label><input name="email" type="email" required [value]="authEmail()" />
          @if (authMode() === "Login" || authMode() === "Register") {
            <label>Password (min 12 characters)</label
            ><input name="password" type="password" minlength="12" required />
          }
          @if (authMode() === "Verify email" || authMode() === "Reset password") {
            <label>Token</label><input name="token" required [value]="authToken()" />
          }
          @if (authMode() === "Reset password") {
            <label>New password (min 12 characters)</label
            ><input name="newPassword" type="password" minlength="12" required />
          }
          <p class="config-error">{{ authError() }}</p>
          <button>{{ authMode() }}</button>
        </form>
        @if (authMode() === "Login") {
          <p>
            <button type="button" (click)="setAuthMode('Register')">Register</button>
            <button type="button" (click)="setAuthMode('Forgot password')">Forgot password</button>
          </p>
        }
        @if (authMode() === "Verify email") {
          <button type="button" (click)="resendVerification()">Resend verification</button>
        }
        @if (authMode() !== "Login") {
          <button type="button" (click)="setAuthMode('Login')">Back to login</button>
        }
      </section>
      <section id="config-panel" class="config" [hidden]="!editing() || authVisible()">
        <form id="config-form" (submit)="submit($event)">
          <h2>Prima connessione</h2>
          <p class="muted">I dati vengono salvati solo nel localStorage di questo browser.</p>
          <label for="broker-url">Broker WebSocket URL</label
          ><input id="broker-url" name="url" type="url" required [value]="config.url" /><label
            for="broker-username"
            >Username</label
          ><input id="broker-username" name="username" required [value]="config.username" /><label
            for="broker-password"
            >Password</label
          ><input
            id="broker-password"
            name="password"
            type="password"
            required
            [value]="config.password"
          /><label for="client-name">Client name</label
          ><input id="client-name" name="name" required maxlength="64" [value]="config.name" />
          <p id="config-error" class="config-error">{{ error() }}</p>
          <button>Connetti</button>
        </form>
      </section>
      <div id="error" [hidden]="!error()">{{ error() }}</div>
      <section id="totals" class="totals">
        <div class="totals-block">
          <span class="metric-label">👥 Peers</span
          ><strong class="metric-value">{{ snapshot()?.totals?.peers ?? 0 }}</strong>
        </div>
        <div class="totals-block">
          <span class="metric-label">📤 Outbound</span>
          @if (snapshot(); as s) {
            <div>
              P2P <strong>{{ s.totals.traffic.tx.p2p.messages }} msg</strong>
              <span class="traffic-bytes">{{ s.totals.traffic.tx.p2p.bytes | p2pByteSize }}</span
              ><br />MQTT <strong>{{ s.totals.traffic.tx.mqtt.messages }} msg</strong>
              <span class="traffic-bytes">{{ s.totals.traffic.tx.mqtt.bytes | p2pByteSize }}</span>
            </div>
          }
        </div>
        <div class="totals-block">
          <span class="metric-label">📥 Inbound</span>
          @if (snapshot(); as s) {
            <div>
              P2P <strong>{{ s.totals.traffic.rx.p2p.messages }} msg</strong>
              <span class="traffic-bytes">{{ s.totals.traffic.rx.p2p.bytes | p2pByteSize }}</span
              ><br />MQTT <strong>{{ s.totals.traffic.rx.mqtt.messages }} msg</strong>
              <span class="traffic-bytes">{{ s.totals.traffic.rx.mqtt.bytes | p2pByteSize }}</span>
            </div>
          }
        </div>
      </section>
      <h2 class="section-title">🔗 Connected peers</h2>
      <div class="table-wrap">
        <table id="peers">
          <thead>
            <tr>
              @for (h of headers; track h) {
                <th>{{ h }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (p of snapshot()?.peers ?? []; track p.peerId) {
              <tr
                [attr.data-peer-id]="p.peerId"
                [attr.data-kind]="p.kind"
                [attr.data-version]="p.version"
                [attr.data-route]="p.route"
                [attr.data-rtt]="p.rttMs ?? 0"
                [attr.data-p2p-bytes]="p.p2pBytes"
                [attr.data-p2p-messages]="p.p2pMessages"
                [attr.data-mqtt-bytes]="p.mqttBytes"
                [attr.data-mqtt-messages]="p.mqttMessages"
                [attr.data-p2p-tx-messages]="p.traffic.tx.p2p.messages"
                [attr.data-p2p-rx-messages]="p.traffic.rx.p2p.messages"
                [attr.data-mqtt-tx-messages]="p.traffic.tx.mqtt.messages"
                [attr.data-mqtt-rx-messages]="p.traffic.rx.mqtt.messages"
                [attr.data-p2p-rate]="p.p2pBytesPerSec"
                [attr.data-mqtt-rate]="p.mqttBytesPerSec"
                [attr.data-pings]="p.pings"
                [attr.data-round-trips]="p.roundTrips"
              >
                <td class="peer">
                  <span class="peer-kind">{{ p.kind === "browser" ? "🌐" : "🖥️" }}</span>
                  <strong>{{ p.name }}</strong>
                  <small class="peer-version">{{ p.version }}</small>
                </td>
                <td>{{ route(p) }}</td>
                <td>{{ p.rttMs?.toFixed(1) ?? "—" }}</td>
                <td>{{ p.p2pBytes | p2pByteSize }}</td>
                <td
                  [title]="'tx ' + p.traffic.tx.p2p.messages + ' / rx ' + p.traffic.rx.p2p.messages"
                >
                  {{ p.p2pMessages }}
                </td>
                <td>{{ p.mqttBytes | p2pByteSize }}</td>
                <td
                  [title]="
                    'tx ' + p.traffic.tx.mqtt.messages + ' / rx ' + p.traffic.rx.mqtt.messages
                  "
                >
                  {{ p.mqttMessages }}
                </td>
                <td>{{ p.p2pBytesPerSec | bytesRate }}</td>
                <td>{{ p.mqttBytesPerSec | bytesRate }}</td>
                <td>{{ p.pings }}</td>
                <td>{{ p.roundTrips }}</td>
                <td>{{ p.lastError }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <section id="issues" class="issues" [hidden]="!recentIssues().length">
        <h2 class="section-title">🐞 Problemi recenti</h2>
        <ul id="issue-list">
          @for (i of recentIssues(); track i.id) {
            <li>
              {{ i.level === "error" ? "❌" : "⚠️" }} {{ i.name }} v{{ i.version }}:
              {{ i.message }} ({{ i.ts | date: "mediumTime" }} {{ i.peerId }})
            </li>
          }
        </ul>
      </section>
    </main>`,
})
class App {
  version = VERSION;
  headers = [
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
  ];
  snapshot = signal<MeshSnapshot | null>(null);
  connected = signal(false);
  online = signal(navigator.onLine);
  editing = signal(true);
  authVisible = signal(true);
  authMode = signal("Login");
  authError = signal("");
  authEmail = signal("");
  authToken = signal("");
  registrySession = signal(false);
  error = signal("");
  identity = signal("Starting…");
  peer: MeshPeer | null = null;
  config: Config = {
    url: DEFAULT_URL,
    username: DEFAULT_USERNAME,
    password: "",
    name: `browser-${crypto.randomUUID().slice(0, 8)}`,
  };
  constructor() {
    const rt = demoWindow.__P2PLINK_DEMO_CONFIG__;
    for (const [key, env] of [
      ["url", "VITE_MQTT_URL"],
      ["username", "VITE_MQTT_USERNAME"],
      ["password", "VITE_MQTT_PASSWORD"],
      ["name", "VITE_PEER_NAME"],
    ] as const) {
      const v = typeof rt?.[key] === "string" ? (rt[key] as string) : appEnv?.[env];
      if (typeof v === "string") this.config[key] = v;
    }
    const registryOverride =
      typeof rt?.registryUrl === "string" ? rt.registryUrl : appEnv?.VITE_REGISTRY_URL;
    this.registryUrl = registryOverride || REGISTRY_URL;
    const auth = new URLSearchParams(location.search).get("auth");
    if (auth === "verify-email" || auth === "reset-password") {
      this.authMode.set(auth === "verify-email" ? "Verify email" : "Reset password");
      this.authEmail.set(new URLSearchParams(location.search).get("email") ?? "");
      this.authToken.set(new URLSearchParams(location.search).get("token") ?? "");
    }
    try {
      const savedTokens = localStorage.getItem(TOKENS_KEY);
      if (savedTokens) void this.connectRegistry(JSON.parse(savedTokens) as RegistryTokens);
      const stored = localStorage.getItem(KEY);
      if (stored) {
        this.authVisible.set(false);
        this.config = { ...this.config, ...JSON.parse(stored) };
        this.editing.set(false);
        if (this.config.url && this.config.username && this.config.password)
          this.start(this.config);
      }
    } catch {
      // Invalid/blocked localStorage: keep the in-memory defaults.
    }
    if (
      !this.peer &&
      !localStorage.getItem(KEY) &&
      typeof rt?.url === "string" &&
      typeof rt?.username === "string" &&
      typeof rt?.password === "string"
    ) {
      this.authVisible.set(false);
      this.editing.set(false);
      this.start(this.config);
    }
    window.addEventListener("online", () => {
      this.online.set(true);
      if (!this.peer) this.start(this.config);
    });
    window.addEventListener("offline", () => this.online.set(false));
    for (const name of ["error", "unhandledrejection", "securitypolicyviolation"])
      window.addEventListener(name, (event) => {
        const e = event as ErrorEvent & {
          reason?: unknown;
          violatedDirective?: string;
        };
        this.peer?.reportIssue("error", name, {
          source: name,
          message: String(e.message ?? e.reason ?? e.violatedDirective ?? ""),
        });
      });
    demoWindow.__P2PLINK_DEMO_TEST__ = {
      setWebRtcEnabled: (v: boolean) => this.peer?.setWebRtcEnabled(v),
    };
  }
  registryUrl = REGISTRY_URL;
  recentIssues() {
    return (this.snapshot()?.recentIssues ?? []).filter((i) => Date.now() - i.ts < 60000);
  }
  route(p: PeerStats) {
    return p.route === "p2p" ? "🟢 p2p" : p.route === "mqtt" ? "🟡 mqtt" : "⏳ connecting";
  }
  setAuthMode(mode: string) {
    this.authMode.set(mode);
    this.authError.set("");
  }
  async authSubmit(e: Event) {
    e.preventDefault();
    const d = new FormData(e.target as HTMLFormElement),
      email = String(d.get("email")),
      password = String(d.get("password") ?? ""),
      token = String(d.get("token") ?? "");
    this.authEmail.set(email);
    this.authError.set("");
    const api = new RegistryApi(this.registryUrl);
    try {
      if (this.authMode() === "Register") {
        await api.register(email, password);
        this.setAuthMode("Verify email");
        return;
      }
      if (this.authMode() === "Verify email") {
        const tokens = await api.verifyEmail(email, token);
        localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
        await this.connectRegistry(tokens);
        return;
      }
      if (this.authMode() === "Forgot password") {
        await api.forgotPassword(email);
        this.authError.set("If the account exists, reset instructions were sent.");
        return;
      }
      if (this.authMode() === "Reset password") {
        await api.resetPassword(email, token, String(d.get("newPassword")));
        this.setAuthMode("Login");
        return;
      }
      const tokens = await api.login(email, password);
      localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
      await this.connectRegistry(tokens);
    } catch (err) {
      this.authError.set(String(err));
    }
  }
  async resendVerification() {
    try {
      await new RegistryApi(this.registryUrl).resendVerification(this.authEmail());
      this.authError.set("Verification email sent.");
    } catch (e) {
      this.authError.set(String(e));
    }
  }
  async connectRegistry(tokens: RegistryTokens) {
    try {
      const api = new RegistryApi(this.registryUrl),
        peer = await ensureRegistryPeer({
          api,
          accessToken: tokens.accessToken,
          storage: localStorage,
          name: this.config.name,
        });
      this.registrySession.set(true);
      this.authVisible.set(false);
      this.start({
        url: peer.mqtt.url,
        username: peer.mqtt.username,
        password: peer.mqtt.password,
        name: peer.peer.name,
        clientId: peer.mqtt.clientId,
        peerId: peer.peer.peerId,
      });
    } catch (e) {
      this.authError.set(String(e));
      this.authVisible.set(true);
    }
  }
  async logout() {
    const peerId = this.identity().match(/\\(([^)]+)\\)/)?.[1];
    try {
      const raw = localStorage.getItem(TOKENS_KEY);
      if (raw)
        await new RegistryApi(this.registryUrl).logout(
          (JSON.parse(raw) as RegistryTokens).refreshToken,
          peerId,
        );
    } catch {
      /* local logout proceeds */
    }
    localStorage.clear();
    this.peer?.stop();
    this.peer = null;
    this.snapshot.set(null);
    this.connected.set(false);
    this.registrySession.set(false);
    this.authVisible.set(true);
    this.identity.set("Not connected");
  }
  submit(e: Event) {
    e.preventDefault();
    const d = new FormData(e.target as HTMLFormElement);
    this.config = {
      url: String(d.get("url")),
      username: String(d.get("username")),
      password: String(d.get("password")),
      name: String(d.get("name")),
    };
    localStorage.setItem(KEY, JSON.stringify(this.config));
    this.start(this.config);
  }
  start(c: Config) {
    if (!navigator.onLine) return;
    this.peer?.stop();
    this.editing.set(false);
    const p = createMeshPeer({
      url: c.url,
      username: c.username,
      password: c.password,
      name: c.name,
      ...(c.clientId ? { clientId: c.clientId } : {}),
      ...(c.peerId ? { peerId: c.peerId } : {}),
      kind: "browser",
      pingBytes: Number(demoWindow.__P2PLINK_DEMO_CONFIG__?.pingBytes ?? 2048),
      iceServers: demoWindow.__P2PLINK_DEMO_CONFIG__?.iceServers,
      version: VERSION,
      presenceIntervalMs: 30000,
      platform: navigator.userAgent,
      engine: createBrowserWebRtcEngine(),
    });
    this.peer = p;
    p.onSnapshot((s) => {
      this.snapshot.set(s);
      this.connected.set(s.brokerConnected);
      this.identity.set(`${s.self.name} (${s.self.peerId})`);
    });
    void p.start().catch((e) => {
      this.error.set(String(e));
      void p.reportIssue("error", "browser connect failed", {
        phase: "mesh-start",
        error: String(e),
        online: navigator.onLine,
        secureContext: window.isSecureContext,
        pageProtocol: location.protocol,
        userAgent: navigator.userAgent,
      });
    });
  }
  openSettings() {
    this.peer?.stop();
    this.peer = null;
    this.snapshot.set(null);
    this.connected.set(false);
    this.identity.set("Not connected");
    this.editing.set(true);
    this.authVisible.set(!this.registrySession());
  }
  reset() {
    if (confirm("Azzerare i contatori e le statistiche di tutti i peer?")) this.peer?.resetStats();
  }
}
bootstrapApplication(App, {
  providers: [
    provideServiceWorker("ngsw-worker.js", {
      enabled: !isDevMode(),
      registrationStrategy: "registerWhenStable:30000",
    }),
  ],
}).catch(console.error);
