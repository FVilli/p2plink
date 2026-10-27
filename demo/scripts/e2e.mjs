import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { verifyPingPayload } from "../shared/dist/index.js";

const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(demoRoot, "..");
const children = [];
const logs = new Map();

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const name = options.name ?? command;
  logs.set(name, "");
  const append = (chunk) => {
    const text = chunk.toString();
    logs.set(name, (logs.get(name) ?? "") + text);
    if (process.env.DEBUG_DEMO_E2E) process.stdout.write(`[${name}] ${text}`);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return child;
}

async function waitHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // retry
    }
    await delay(250);
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function waitBackendStats(url, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fetch(url).then((response) => response.json());
    if (predicate(last)) return last;
    await delay(500);
  }
  throw new Error(`timeout waiting for ${url}: ${JSON.stringify(last?.totals ?? last)}`);
}

async function stopChildren() {
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    child.kill("SIGTERM");
  }
  await delay(500);
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

function fail(message) {
  console.error(`DEMO E2E: FAILED — ${message}`);
  for (const [name, log] of logs) {
    console.error(`--- ${name} ---\n${log.split("\n").slice(-40).join("\n")}`);
  }
  process.exitCode = 1;
}

const backendEntry = resolve(demoRoot, "backend/dist/main.js");
const webDist = resolve(demoRoot, "web/dist/index.html");
if (!existsSync(backendEntry)) throw new Error(`missing ${backendEntry}; run demo build`);
if (!existsSync(webDist)) throw new Error(`missing ${webDist}; run demo build`);

start(process.execPath, [backendEntry], {
  name: "nest-a",
  env: {
    MQTT_URL: "mqtt://127.0.0.1:1884",
    MQTT_USERNAME: "demo",
    MQTT_PASSWORD: "demo-pass",
    PEER_NAME: "e2e-nest-a",
    PORT: "3100",
    PING_BYTES: "2048",
    STUN_URLS: "",
    WEBRTC_ENABLED: "true",
  },
});
start(process.execPath, [backendEntry], {
  name: "nest-b",
  env: {
    MQTT_URL: "mqtt://127.0.0.1:1884",
    MQTT_USERNAME: "demo",
    MQTT_PASSWORD: "demo-pass",
    PEER_NAME: "e2e-nest-b",
    PORT: "3101",
    PING_BYTES: "2048",
    STUN_URLS: "",
    WEBRTC_ENABLED: "true",
  },
});
start(
  "pnpm",
  [
    "--filter",
    "@p2plink/demo-web",
    "exec",
    "vite",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "5174",
  ],
  {
    name: "web",
    cwd: demoRoot,
  },
);

async function assertIntegrityPrimitive() {
  const raw = new TextEncoder().encode("p2plink-demo-integrity");
  const bytes = Buffer.from(raw).toString("base64url");
  const hash = await import("node:crypto").then(({ createHash }) =>
    createHash("sha256").update(raw).digest("base64url"),
  );
  if (!(await verifyPingPayload({ size: raw.length, bytes, hash }))) {
    throw new Error("valid ping payload rejected");
  }
  const tampered = Buffer.from(raw);
  tampered[0] ^= 0xff;
  if (
    await verifyPingPayload({
      size: tampered.length,
      bytes: tampered.toString("base64url"),
      hash,
    })
  ) {
    throw new Error("tampered ping payload accepted");
  }
}

let browser;
try {
  await assertIntegrityPrimitive();
  console.log("0. ping integrity primitive accepts valid and rejects tampered bytes");
  await waitHttp("http://127.0.0.1:3100/health");
  await waitHttp("http://127.0.0.1:3101/health");
  await waitHttp("http://127.0.0.1:5174/");
  console.log("1. backends and web preview ready");

  browser = await chromium.launch({
    ...(process.env.P2PLINK_CHROME_PATH ? { executablePath: process.env.P2PLINK_CHROME_PATH } : {}),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const localConfig = {
    url: "ws://127.0.0.1:9002",
    username: "demo",
    password: "demo-pass",
    iceServers: [],
  };
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const installConfig = (config) => {
    window.__P2PLINK_DEMO_CONFIG__ = config;
  };
  await contextA.addInitScript(installConfig, localConfig);
  await contextB.addInitScript(installConfig, localConfig);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const errors = [];
  for (const [name, page] of [
    ["A", pageA],
    ["B", pageB],
  ]) {
    page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`${name}: ${message.text()}`);
    });
  }
  await pageA.goto("http://127.0.0.1:5174/");
  await pageB.goto("http://127.0.0.1:5174/");

  const peerRows = async (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll("#peers tbody tr")].map((row) => ({
        peerId: row.getAttribute("data-peer-id") ?? "",
        route: row.getAttribute("data-route") ?? "",
        rtt: Number(row.getAttribute("data-rtt") ?? 0),
        p2pBytes: Number(row.getAttribute("data-p2p-bytes") ?? 0),
        mqttBytes: Number(row.getAttribute("data-mqtt-bytes") ?? 0),
        p2pRate: Number(row.getAttribute("data-p2p-rate") ?? 0),
        mqttRate: Number(row.getAttribute("data-mqtt-rate") ?? 0),
        pings: Number(row.getAttribute("data-pings") ?? 0),
        roundTrips: Number(row.getAttribute("data-round-trips") ?? 0),
      })),
    );

  await pageA.waitForFunction(
    () => document.querySelectorAll("#peers tbody tr").length >= 3,
    null,
    {
      timeout: 30_000,
    },
  );
  await pageB.waitForFunction(
    () => document.querySelectorAll("#peers tbody tr").length >= 3,
    null,
    {
      timeout: 30_000,
    },
  );
  console.log("2. peer discovery: two browsers and two NestJS peers visible");

  await pageA.waitForFunction(
    () =>
      [...document.querySelectorAll("#peers tbody tr")].length >= 3 &&
      [...document.querySelectorAll("#peers tbody tr")].every(
        (row) =>
          Number(row.getAttribute("data-pings") ?? 0) > 0 &&
          Number(row.getAttribute("data-round-trips") ?? 0) > 0,
      ),
    null,
    { timeout: 40_000 },
  );
  await pageB.waitForFunction(
    () =>
      [...document.querySelectorAll("#peers tbody tr")].length >= 3 &&
      [...document.querySelectorAll("#peers tbody tr")].every(
        (row) =>
          Number(row.getAttribute("data-pings") ?? 0) > 0 &&
          Number(row.getAttribute("data-round-trips") ?? 0) > 0,
      ),
    null,
    { timeout: 40_000 },
  );
  console.log("3. every browser peer completed a ping with every other peer");

  await pageA.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll("#peers tbody tr")];
      const p2p = (kind) =>
        rows.some(
          (row) =>
            row.getAttribute("data-kind") === kind &&
            row.getAttribute("data-route") === "p2p" &&
            Number(row.getAttribute("data-p2p-bytes") ?? 0) > 0,
        );
      return p2p("browser") && p2p("nest");
    },
    null,
    { timeout: 40_000 },
  );
  const p2pBefore = await peerRows(pageA);
  console.log(
    "4. P2P ping traffic observed",
    p2pBefore.filter((row) => row.p2pBytes > 0),
  );

  const backendStats = await waitBackendStats(
    "http://127.0.0.1:3100/stats",
    (stats) =>
      stats.totals?.p2pBytes > 0 &&
      stats.peers?.length >= 3 &&
      stats.peers.every((peer) => peer.pings > 0 && peer.roundTrips > 0 && peer.route === "p2p") &&
      stats.peers.some((peer) => peer.kind === "browser") &&
      stats.peers.some((peer) => peer.kind === "nest"),
  );
  await waitBackendStats(
    "http://127.0.0.1:3101/stats",
    (stats) =>
      stats.peers?.some(
        (peer) => peer.name === "e2e-nest-a" && peer.kind === "nest" && peer.route === "p2p",
      ) && stats.peers?.some((peer) => peer.kind === "browser" && peer.route === "p2p"),
  );
  console.log("5. NestJS console/mesh stats show P2P traffic", backendStats.totals);

  const mqttBefore = (await peerRows(pageA)).reduce((sum, row) => sum + row.mqttBytes, 0);
  await pageA.click("#toggle-p2p");
  await pageA.waitForFunction(
    () =>
      [...document.querySelectorAll("#peers tbody tr")].some(
        (row) => row.getAttribute("data-route") === "mqtt",
      ),
    null,
    { timeout: 20_000 },
  );
  await pageA.waitForFunction(
    (before) =>
      [...document.querySelectorAll("#peers tbody tr")].reduce(
        (sum, row) => sum + Number(row.getAttribute("data-mqtt-bytes") ?? 0),
        0,
      ) >
      before + 2048,
    mqttBefore,
    { timeout: 20_000 },
  );
  console.log("6. forced fallback: ping bytes now transit on MQTT");

  await pageA.click("#toggle-p2p");
  await pageA.waitForFunction(
    () =>
      [...document.querySelectorAll("#peers tbody tr")].some(
        (row) =>
          row.getAttribute("data-route") === "p2p" &&
          Number(row.getAttribute("data-p2p-bytes") ?? 0) > 0,
      ),
    null,
    { timeout: 40_000 },
  );
  console.log("7. P2P restored and ping bytes continue on DataChannel");

  const contextC = await browser.newContext();
  const pageC = await contextC.newPage();
  await pageC.goto("http://127.0.0.1:5174/");
  await pageC.locator("#config-panel:not([hidden])").waitFor({ timeout: 10_000 });
  const defaults = await pageC.evaluate(() => ({
    url: document.querySelector("#broker-url")?.value,
    username: document.querySelector("#broker-username")?.value,
    name: document.querySelector("#client-name")?.value,
  }));
  if (
    !defaults.url?.startsWith("wss://") ||
    defaults.username !== "main:rmq-usr" ||
    !defaults.name
  ) {
    throw new Error(`unexpected onboarding defaults: ${JSON.stringify(defaults)}`);
  }
  await pageC.fill("#broker-url", "ws://127.0.0.1:9002");
  await pageC.fill("#broker-username", "demo");
  await pageC.fill("#broker-password", "demo-pass");
  await pageC.fill("#client-name", "e2e-onboard");
  await pageC.click("#config-form button[type=submit]");
  await pageC.waitForFunction(
    () => document.querySelector("#broker-state")?.getAttribute("data-connected") === "true",
    null,
    { timeout: 20_000 },
  );
  const stored = await pageC.evaluate(() => localStorage.getItem("p2plink-demo-config"));
  if (!stored || !stored.includes("e2e-onboard") || !stored.includes("ws://127.0.0.1:9002")) {
    throw new Error(`onboarding config not stored: ${stored}`);
  }
  await contextC.close();
  console.log("8. onboarding form saved url/username/password/client name in localStorage");

  const pwaContext = await browser.newContext();
  const pwaPage = await pwaContext.newPage();
  await pwaPage.goto("http://127.0.0.1:5174/", { waitUntil: "networkidle" });
  await pwaPage.waitForFunction(() => navigator.serviceWorker.ready.then(() => true), null, {
    timeout: 15_000,
  });
  await pwaPage.reload({ waitUntil: "networkidle" });
  if (!(await pwaPage.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
    throw new Error("service worker is not controlling the PWA");
  }
  await pwaContext.setOffline(true);
  await pwaPage.reload({ waitUntil: "domcontentloaded" });
  if (!(await pwaPage.locator("#offline-banner").isVisible())) {
    throw new Error("offline banner not visible after offline reload");
  }
  const pwaVersion = await pwaPage.locator("#app-version").innerText();
  if (!pwaVersion.startsWith("v")) throw new Error(`missing app version: ${pwaVersion}`);
  await pwaContext.close();
  console.log("9. PWA opens offline from service worker cache and shows offline banner/version");

  const content = await pageA.locator("body").innerText();
  if (/hash mismatch|integrity/i.test(content))
    throw new Error(`integrity error visible: ${content.slice(0, 500)}`);
  const pagesErrors = errors.filter((error) => !/favicon|404/i.test(error));
  if (pagesErrors.length > 0) throw new Error(`browser errors: ${pagesErrors.join(" | ")}`);

  await pageA.screenshot({ path: "/tmp/p2plink-mesh-demo.png", fullPage: true });
  console.log("DEMO E2E: SUCCESS");
} catch (error) {
  try {
    if (browser) {
      for (const [index, page] of browser
        .contexts()
        .flatMap((context) => context.pages())
        .entries()) {
        const rows = await page.evaluate(() =>
          [...document.querySelectorAll("#peers tbody tr")].map((row) => ({
            kind: row.getAttribute("data-kind"),
            route: row.getAttribute("data-route"),
            p2p: row.getAttribute("data-p2p-bytes"),
            mqtt: row.getAttribute("data-mqtt-bytes"),
            pings: row.getAttribute("data-pings"),
            roundTrips: row.getAttribute("data-round-trips"),
            error: row.lastElementChild?.textContent,
          })),
        );
        console.error(`page${index} rows`, rows);
      }
    }
    const stats = await fetch("http://127.0.0.1:3100/stats").then((response) => response.json());
    console.error(
      "nest stats",
      stats.peers?.map((peer) => ({
        name: peer.name,
        kind: peer.kind,
        route: peer.route,
        p2p: peer.p2pBytes,
        mqtt: peer.mqttBytes,
      })),
    );
  } catch {
    // diagnostics are best-effort
  }
  fail(error instanceof Error ? error.message : String(error));
  try {
    if (browser) {
      const pages = browser.contexts().flatMap((context) => context.pages());
      if (pages[0])
        await pages[0].screenshot({ path: "/tmp/p2plink-mesh-demo-failure.png", fullPage: true });
    }
  } catch {
    // ignore
  }
} finally {
  if (browser) await browser.close();
  await stopChildren();
}
