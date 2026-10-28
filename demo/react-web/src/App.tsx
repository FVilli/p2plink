import { useEffect, useState } from "react";
import {
  createMeshPeer,
  type MeshIssue,
  type MeshPeer,
  type MeshSnapshot,
  type PeerStats,
  RegistryApi,
  ensureRegistryPeer,
  DEFAULT_REGISTRY_URL,
  toFriendlyPeerName,
  type RegistryTokens,
} from "@p2plink/demo-mesh";
import { formatByteSize } from "@p2plink/core";
import { createBrowserWebRtcEngine } from "@p2plink/webrtc";

type Config = {
  url: string;
  username: string;
  password: string;
  name: string;
  clientId?: string;
  peerId?: string;
};
const KEY = "p2plink-demo-config",
  ACCESS_KEY = "p2plink-registry-access-token",
  REFRESH_KEY = "p2plink-registry-refresh-token",
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
  const [passwordVisible, setPasswordVisible] = useState<Record<string, boolean>>({});
  const [snapshot, setSnapshot] = useState<MeshSnapshot | null>(null);
  const [tokens, setTokens] = useState<RegistryTokens | null>(() => {
    const accessToken = localStorage.getItem(ACCESS_KEY),
      refreshToken = localStorage.getItem(REFRESH_KEY);
    return accessToken && refreshToken ? { accessToken, refreshToken } : null;
  });
  const [authMode, setAuthMode] = useState(() => {
    const auth = new URLSearchParams(location.search).get("auth");
    return auth === "verify-email" || auth === "reset-password" ? auth : "login";
  });
  const [authMessage, setAuthMessage] = useState("");
  const [friendly, setFriendly] = useState(
    () => localStorage.getItem("p2plink-friendly-name") ?? "",
  );
  const registryUrl = runtimeString("registryUrl") ?? env.VITE_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
  const [config, setConfig] = useState<Config>(() => loadConfig() ?? defaults());
  const [brokerUrl, setBrokerUrl] = useState("");
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
    setBrokerUrl(c.url);
    try {
      localStorage.setItem(KEY, JSON.stringify(c));
    } catch {
      /* Storage can be unavailable. */
    }
    const previous = peer;
    setPeer(null);
    if (previous) await previous.stop().catch(() => undefined);
    if (!navigator.onLine) {
      setError("Sei offline. La mesh riprenderà online.");
      return;
    }
    setError("");
    let mesh: MeshPeer;
    try {
      mesh = createMeshPeer({
        url: c.url,
        username: c.username,
        password: c.password,
        name: c.name,
        ...(c.clientId ? { clientId: c.clientId } : {}),
        ...(c.peerId ? { peerId: c.peerId } : {}),
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
    }
  }
  async function authenticate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setAuthMessage("");
    const d = new FormData(e.currentTarget),
      email = String(d.get("email") || "").trim(),
      password = String(d.get(authMode === "reset-password" ? "newPassword" : "password") || ""),
      token = String(d.get("token") || ""),
      requestedName = authMode === "login" ? String(d.get("friendly") || "").trim() : friendly;
    if (authMode === "login") {
      setFriendly(requestedName);
      localStorage.setItem("p2plink-friendly-name", requestedName || defaultName);
    }
    const api = new RegistryApi(registryUrl);
    try {
      if (authMode === "resend") {
        await api.resendVerification(email);
        setAuthMessage("Verification email sent.");
      } else if (authMode === "register") {
        if (password !== String(d.get("confirmPassword") || ""))
          throw new Error("Passwords do not match.");
        await api.register(email, password);
        setAuthMessage("Registration complete. Check your email to verify your account.");
        setAuthMode("login");
      } else if (authMode === "forgot") {
        await api.forgotPassword(email);
        setAuthMessage("If the account exists, a reset link has been sent.");
      } else if (authMode === "verify-email") {
        const result = await api.verifyEmail(email, token);
        await acceptTokens(result, requestedName);
      } else if (authMode === "reset-password") {
        if (password !== String(d.get("confirmNewPassword") || ""))
          throw new Error("Passwords do not match.");
        await api.resetPassword(email, token, password);
        setAuthMessage("Password updated. Please log in.");
        setAuthMode("login");
      } else {
        await acceptTokens(await api.login(email, password), requestedName);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  async function acceptTokens(value: RegistryTokens, requestedName = friendly) {
    localStorage.setItem(ACCESS_KEY, value.accessToken);
    localStorage.setItem(REFRESH_KEY, value.refreshToken);
    setTokens(value);
    const api = new RegistryApi(registryUrl);
    try {
      const peerInfo = await ensureRegistryPeer({
        api,
        accessToken: value.accessToken,
        storage: localStorage,
        name: toFriendlyPeerName(requestedName || defaultName),
      });
      await connect({ ...peerInfo.mqtt, name: peerInfo.peer.name, peerId: peerInfo.peer.peerId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  async function logout() {
    const current = peer;
    setPeer(null);
    setSnapshot(null);
    if (current) await current.stop().catch(() => undefined);
    const refresh = localStorage.getItem(REFRESH_KEY),
      peerId = snapshot?.self.peerId;
    if (refresh) await new RegistryApi(registryUrl).logout(refresh, peerId).catch(() => undefined);
    localStorage.clear();
    setTokens(null);
    setFriendly("");
    setError("");
  }
  async function resendVerification(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") || "").trim();
    try {
      await new RegistryApi(registryUrl).resendVerification(email);
      setAuthMessage("Verification email sent.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    if (tokens && !peer && navigator.onLine)
      void (async () => {
        try {
          const info = await ensureRegistryPeer({
            api: new RegistryApi(registryUrl),
            accessToken: tokens.accessToken,
            storage: localStorage,
            name: toFriendlyPeerName(friendly || defaultName),
          });
          await connect({ ...info.mqtt, name: info.peer.name, peerId: info.peer.peerId });
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setTokens(null);
        }
      })();
  }, []);
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
            <span id="broker-dot">{snapshot?.brokerConnected ? "🟢" : online ? "🔴" : "⚪"}</span>
            <strong>MQTT</strong>
            <small id="broker-url">{brokerUrl || "—"}</small>
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
            {tokens && (
              <button
                id="logout"
                className="icon-button"
                title="Logout"
                aria-label="Logout"
                onClick={() => void logout()}
              >
                🚪
              </button>
            )}
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
        {!tokens &&
          !loadConfig() &&
          !(runtimeString("url") && runtimeString("username") && runtimeString("password")) && (
            <section className="config auth-panel">
              <form
                onSubmit={
                  authMode === "verify-email" || authMode === "reset-password"
                    ? authenticate
                    : authMode === "resend"
                      ? resendVerification
                      : authenticate
                }
              >
                <div className="auth-modes">
                  {(
                    [
                      ["login", "🔑 Sign in", "auth-signin"],
                      ["register", "✨ Create", "auth-create"],
                      ["forgot", "🔐 Forgot", "auth-forgot"],
                      ["resend", "📨 Resend", "auth-resend"],
                    ] as const
                  ).map(([mode, label, color]) => (
                    <button
                      key={mode}
                      className={`auth-mode ${color}`}
                      type="button"
                      onClick={() => setAuthMode(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <h2>
                  Registry{" "}
                  {authMode === "register"
                    ? "registration"
                    : authMode === "verify-email"
                      ? "Verify email"
                      : authMode === "reset-password"
                        ? "Reset password"
                        : authMode === "forgot"
                          ? "Forgot password"
                          : "login"}
                </h2>
                <p className="muted">Registry: {registryUrl}</p>
                {authMode === "verify-email" || authMode === "reset-password" ? (
                  <input
                    name="token"
                    required
                    placeholder="Email token"
                    defaultValue={new URLSearchParams(location.search).get("token") ?? ""}
                  />
                ) : null}
                {authMode === "resend" ||
                authMode === "verify-email" ||
                authMode === "reset-password" ||
                authMode === "login" ||
                authMode === "register" ||
                authMode === "forgot" ? (
                  <input
                    name="email"
                    type="email"
                    required
                    placeholder="Email"
                    defaultValue={new URLSearchParams(location.search).get("email") ?? ""}
                  />
                ) : null}
                {authMode === "login" ||
                authMode === "register" ||
                authMode === "reset-password" ? (
                  <>
                    <input
                      name={authMode === "reset-password" ? "newPassword" : "password"}
                      type={passwordVisible.password ? "text" : "password"}
                      required
                      minLength={authMode === "login" ? 1 : 8}
                      placeholder={
                        authMode === "reset-password" ? "New password (min 8)" : "Password (min 8)"
                      }
                    />
                    <button
                      type="button"
                      title={passwordVisible.password ? "Hide password" : "Show password"}
                      aria-label={passwordVisible.password ? "Hide password" : "Show password"}
                      onClick={() => setPasswordVisible((v) => ({ ...v, password: !v.password }))}
                    >
                      👁️
                    </button>
                  </>
                ) : null}
                {authMode === "register" ? (
                  <>
                    <input
                      name="confirmPassword"
                      type={passwordVisible.confirm ? "text" : "password"}
                      required
                      minLength={8}
                      placeholder="Confirm password"
                    />
                    <button
                      type="button"
                      title={
                        passwordVisible.confirm ? "Hide confirm password" : "Show confirm password"
                      }
                      aria-label={
                        passwordVisible.confirm ? "Hide confirm password" : "Show confirm password"
                      }
                      onClick={() => setPasswordVisible((v) => ({ ...v, confirm: !v.confirm }))}
                    >
                      👁️
                    </button>
                  </>
                ) : null}
                {authMode === "reset-password" ? (
                  <>
                    <input
                      name="confirmNewPassword"
                      type={passwordVisible.confirmNew ? "text" : "password"}
                      required
                      minLength={8}
                      placeholder="Confirm new password"
                    />
                    <button
                      type="button"
                      title={
                        passwordVisible.confirmNew
                          ? "Hide confirm new password"
                          : "Show confirm new password"
                      }
                      aria-label={
                        passwordVisible.confirmNew
                          ? "Hide confirm new password"
                          : "Show confirm new password"
                      }
                      onClick={() =>
                        setPasswordVisible((v) => ({ ...v, confirmNew: !v.confirmNew }))
                      }
                    >
                      👁️
                    </button>
                  </>
                ) : null}
                {authMode === "login" ? (
                  <input
                    name="friendly"
                    type="text"
                    maxLength={50}
                    placeholder="Client name (e.g. monster)"
                    value={friendly}
                    onChange={(e) => setFriendly(e.target.value)}
                  />
                ) : null}
                <button
                  type="submit"
                  className={
                    authMode === "reset-password"
                      ? "auth-reset"
                      : authMode === "register"
                        ? "auth-create"
                        : authMode === "forgot"
                          ? "auth-forgot"
                          : authMode === "resend"
                            ? "auth-resend"
                            : "auth-signin"
                  }
                >
                  {authMode === "verify-email"
                    ? "Verify email"
                    : authMode === "reset-password"
                      ? "Reset password"
                      : authMode === "forgot"
                        ? "Forgot"
                        : authMode === "resend"
                          ? "Resend"
                          : authMode === "register"
                            ? "Create"
                            : "Sign in"}
                </button>
                <p className="config-error" role="alert">
                  {error}
                </p>
                <p className="muted">{authMessage}</p>
              </form>
            </section>
          )}
        {error && (
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
