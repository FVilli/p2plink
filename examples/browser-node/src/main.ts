import type { ConnectionSnapshot } from "@p2plink/core";
import { httpBootstrapProvider } from "@p2plink/client";
import {
  exportIdentity,
  generateIdentity,
  importIdentity,
  type IdentityKeyPair,
} from "@p2plink/crypto";
import { createP2PLinkClient } from "@p2plink/client";

interface DemoRpc {
  "data.list": {
    request: void;
    response: {
      items: Array<{ id: string; name: string }>;
      subject: string;
      transport: string;
      sessionId: string;
    };
  };
  "data.add": {
    request: { name: string };
    response: { id: string; name: string };
  };
  "system.info": {
    request: void;
    response: Record<string, unknown>;
  };
}

interface DemoEvents {
  "data.updated": { items: Array<{ id: string; name: string }> };
  "server.tick": { at: string };
  "demo.event": unknown;
}

const API_BASE = "http://127.0.0.1:8787";
const MQTT_WS_URL = "ws://127.0.0.1:9001";
const IDENTITY_KEY = "p2plink-demo-identity";
const noP2P = new URLSearchParams(location.search).has("nop2p");

const logElement = document.querySelector<HTMLPreElement>("#log")!;
const itemsElement = document.querySelector<HTMLUListElement>("#items")!;
const badge = document.querySelector<HTMLSpanElement>("#status-badge")!;
const transportElement = document.querySelector<HTMLSpanElement>("#transport")!;
const rttElement = document.querySelector<HTMLSpanElement>("#rtt")!;
const pendingElement = document.querySelector<HTMLSpanElement>("#pending")!;
const sessionElement = document.querySelector<HTMLSpanElement>("#session")!;
const clientElement = document.querySelector<HTMLSpanElement>("#client")!;
const errorElement = document.querySelector<HTMLDivElement>("#error")!;
const suspendButton = document.querySelector<HTMLButtonElement>("#suspend")!;
const resumeButton = document.querySelector<HTMLButtonElement>("#resume")!;

function log(message: string): void {
  const stamp = new Date().toLocaleTimeString();
  logElement.textContent = `${stamp} ${message}\n${logElement.textContent ?? ""}`.slice(0, 20_000);
}

async function loadIdentity(): Promise<IdentityKeyPair> {
  const stored = localStorage.getItem(IDENTITY_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as {
        identityId: string;
        publicKeyJwk: JsonWebKey;
        privateKeyJwk: JsonWebKey;
      };
      return await importIdentity(parsed);
    } catch {
      localStorage.removeItem(IDENTITY_KEY);
    }
  }
  const identity = await generateIdentity("client-demo", { extractable: true });
  const exported = await exportIdentity(identity);
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(exported));
  return identity;
}

async function main(): Promise<void> {
  const identity = await loadIdentity();
  const client = createP2PLinkClient<DemoRpc, DemoEvents>({
    serverId: "demo-server",
    tenant: "demo",
    clientId: "client-demo",
    bootstrap: httpBootstrapProvider({
      url: `${API_BASE}/p2plink/v1/bootstrap`,
      getAccessToken: () => "demo-token",
      allowInsecureHttp: true,
    }),
    security: { identity, allowInsecureBootstrap: true },
    mqtt: {
      url: MQTT_WS_URL,
      credentials: async () => ({ username: "client-demo", password: "demo-dev-password" }),
    },
    webrtc: {
      enabled: !noP2P,
      iceServers: [],
      reconnect: { baseDelayMs: 500, maxDelayMs: 5_000, maxAttempts: 20 },
    },
    limits: {
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 4_000,
      promoteAfterMs: 1_000,
      requestTimeoutMs: 10_000,
    },
    logger: {
      debug: (message, meta) => console.debug(`[p2plink] ${message}`, meta ?? ""),
      info: (message, meta) => console.info(`[p2plink] ${message}`, meta ?? ""),
      warn: (message, meta) => console.warn(`[p2plink] ${message}`, meta ?? ""),
      error: (message, meta) => console.error(`[p2plink] ${message}`, meta ?? ""),
    },
  });

  client.onStatus(bindStatus);
  client.on("data.updated", (payload) => {
    renderItems(payload.items);
    log(`evento data.updated (${payload.items.length} elementi)`);
  });
  client.on("server.tick", (payload) => log(`evento server.tick ${payload.at}`));
  client.on("demo.event", (payload) => log(`evento demo.event ${JSON.stringify(payload)}`));

  document.querySelector("#refresh")!.addEventListener("click", () => {
    void run("data.list");
  });
  document.querySelector("#add")!.addEventListener("click", () => {
    void run("data.add", { name: `Elemento ${new Date().toLocaleTimeString()}` });
  });
  document.querySelector("#info")!.addEventListener("click", () => {
    void run("system.info");
  });
  document.querySelector("#drop-p2p")!.addEventListener("click", async () => {
    const response = await fetch(`${API_BASE}/debug/drop-p2p`, { method: "POST" });
    log(`guasto P2P simulato: HTTP ${response.status}`);
  });
  document.querySelector("#emit")!.addEventListener("click", async () => {
    const response = await fetch(`${API_BASE}/debug/emit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "demo.event", data: { at: new Date().toISOString() } }),
    });
    log(`evento inviato: HTTP ${response.status}`);
  });
  suspendButton.addEventListener("click", async () => {
    await client.suspend();
    suspendButton.disabled = true;
    resumeButton.disabled = false;
    log("rete sospesa: richieste pendenti fallite, trasporti chiusi");
  });
  resumeButton.addEventListener("click", async () => {
    resumeButton.disabled = true;
    try {
      await client.connect();
      suspendButton.disabled = false;
      log("rete ripristinata: nuova sessione stabilita");
    } catch (error) {
      log(`ripristino fallito: ${String(error)}`);
    }
  });

  try {
    await client.connect();
    log(`connesso: session ${client.getStatus().sessionId}`);
    await run("data.list");
  } catch (error) {
    log(`connessione fallita: ${String(error)}`);
  }

  async function run(
    method: keyof DemoRpc & string,
    request?: DemoRpc[keyof DemoRpc]["request"],
  ): Promise<void> {
    try {
      if (method === "data.list") {
        const result = await client.request("data.list");
        renderItems(result.items);
        log(`data.list via ${result.transport} (${result.subject})`);
      } else if (method === "data.add") {
        const result = await client.request("data.add", request as { name: string }, {
          idempotent: true,
          idempotencyKey: crypto.randomUUID(),
        });
        log(`data.add → ${result.name}`);
      } else {
        const result = await client.request("system.info");
        log(`system.info ${JSON.stringify(result)}`);
      }
    } catch (error) {
      log(`errore ${method}: ${String(error)}`);
    }
  }

  function renderItems(items: Array<{ id: string; name: string }>): void {
    itemsElement.innerHTML = "";
    for (const item of items) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = item.name;
      const id = document.createElement("span");
      id.textContent = item.id;
      li.append(name, id);
      itemsElement.append(li);
    }
  }

  function bindStatus(snapshot: ConnectionSnapshot): void {
    console.info(
      `[status] ${snapshot.status} transport=${snapshot.transport} rtt=${snapshot.rttMs}`,
    );
    badge.textContent = snapshot.status;
    badge.dataset.status = snapshot.status;
    transportElement.textContent = `transport: ${snapshot.transport ?? "—"}`;
    rttElement.textContent = `rtt: ${snapshot.rttMs === null ? "—" : `${snapshot.rttMs} ms`}`;
    pendingElement.textContent = `pending: ${snapshot.pendingRequests}`;
    sessionElement.textContent = `session: ${snapshot.sessionId?.slice(0, 12) ?? "—"}`;
    clientElement.textContent = `client: ${snapshot.clientId ?? "—"}`;
    if (snapshot.lastError) {
      errorElement.hidden = false;
      errorElement.textContent = `${snapshot.lastError.code}: ${snapshot.lastError.message}`;
    } else {
      errorElement.hidden = true;
    }
    if (snapshot.status === "closed" || snapshot.status === "offline") {
      resumeButton.disabled = false;
      suspendButton.disabled = true;
    }
  }
}

main().catch((error: unknown) => {
  log(`fatal: ${String(error)}`);
  console.error(error);
});
