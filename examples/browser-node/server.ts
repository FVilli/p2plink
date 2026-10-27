import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomToken } from "@p2plink/core";
import {
  exportIdentity,
  generateIdentity,
  importIdentity,
  type IdentityKeyPair,
} from "@p2plink/crypto";
import { createNodeWebRtcEngine } from "@p2plink/webrtc/node";
import { P2PLinkServer, handleNodeBootstrapRequest } from "@p2plink/server";

const MQTT_TCP_URL = process.env.MQTT_URL ?? "mqtt://127.0.0.1:1883";
const MQTT_WS_URL = process.env.MQTT_WS_URL ?? "ws://127.0.0.1:9001";
const HTTP_PORT = Number(process.env.PORT ?? 8787);
const ALLOWED_ORIGINS = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);

const logger = {
  debug: (message: string, meta?: Record<string, unknown>) =>
    console.debug(`[p2plink] ${message}`, meta ?? ""),
  info: (message: string, meta?: Record<string, unknown>) =>
    console.info(`[p2plink] ${message}`, meta ?? ""),
  warn: (message: string, meta?: Record<string, unknown>) =>
    console.warn(`[p2plink] ${message}`, meta ?? ""),
  error: (message: string, meta?: Record<string, unknown>) =>
    console.error(`[p2plink] ${message}`, meta ?? ""),
};

async function loadServerIdentity(): Promise<IdentityKeyPair> {
  const file = resolve(process.cwd(), ".data/server-identity.json");
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, "utf8")) as {
      identityId: string;
      publicKeyJwk: JsonWebKey;
      privateKeyJwk: JsonWebKey;
    };
    return importIdentity(stored);
  }
  const identity = await generateIdentity("demo-server", { extractable: true });
  const exported = await exportIdentity(identity);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(exported, null, 2), { mode: 0o600 });
  return identity;
}

interface Item {
  id: string;
  name: string;
}

async function main(): Promise<void> {
  const identity = await loadServerIdentity();
  const items: Item[] = [
    { id: "1", name: "Primo elemento" },
    { id: "2", name: "Secondo elemento" },
  ];
  const server = new P2PLinkServer({
    serverId: "demo-server",
    tenant: "demo",
    identity,
    logger,
    bootstrap: {
      authenticator: {
        async authenticate({ authorization }) {
          if (authorization !== "Bearer demo-token") {
            throw new Error("Invalid demo token");
          }
          return { subject: "demo-user", clientId: "client-demo", claims: { role: "admin" } };
        },
      },
      mqttCredentials: async ({ clientId }) => ({
        url: MQTT_WS_URL,
        username: clientId,
        password: "demo-dev-password",
      }),
      maxRequestsPerMinute: 60,
    },
    mqtt: {
      url: MQTT_TCP_URL,
      username: "p2plink-server",
      password: "server-dev-password",
      clientId: "p2plink-demo-server",
    },
    webrtc: {
      enabled: true,
      engine: createNodeWebRtcEngine(),
      iceServers: [],
    },
    limits: {
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 4_000,
      promoteAfterMs: 1_000,
      requestTimeoutMs: 10_000,
      sessionIdleTimeoutMs: 30_000,
    },
  });

  server.register("data.list", async (_request, context) => {
    await delay(120);
    return {
      items,
      subject: context.identity.subject,
      transport: context.transport,
      sessionId: context.sessionId,
    };
  });
  server.register(
    "data.add",
    async (request, context) => {
      const { name } = request as { name: string };
      await delay(80);
      const item: Item = { id: randomToken(4), name };
      items.push(item);
      await server.emitTo(context.clientId, "data.updated", { items });
      return item;
    },
    { idempotent: true, timeoutMs: 5_000 },
  );
  server.register("system.info", (_request, context) => ({
    subject: context.identity.subject,
    clientId: context.clientId,
    sessionId: context.sessionId,
    transport: context.transport,
    claims: context.identity.claims ?? null,
  }));

  await server.start();

  const tick = setInterval(() => {
    void server.emitTo("client-demo", "server.tick", { at: new Date().toISOString() });
  }, 10_000);
  tick.unref();

  const http = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "origin");
      response.setHeader("access-control-allow-headers", "authorization,content-type");
      response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    try {
      if (url.pathname === "/p2plink/v1/bootstrap") {
        await handleNodeBootstrapRequest(server, request, response);
        return;
      }
      if (url.pathname === "/health") {
        json(response, 200, { ok: true, sessions: server.getSessionInfo() });
        return;
      }
      if (url.pathname === "/debug/drop-p2p" && request.method === "POST") {
        const dropped = await server.dropP2P("client-demo");
        json(response, dropped ? 200 : 404, { dropped });
        return;
      }
      if (url.pathname === "/debug/emit" && request.method === "POST") {
        const body = await readJson(request);
        const event = typeof body.event === "string" ? body.event : "demo.event";
        const delivered = await server.emitTo("client-demo", event, body.data ?? {});
        json(response, 200, { delivered });
        return;
      }
      if (url.pathname === "/debug/info") {
        json(response, 200, { sessions: server.getSessionInfo() });
        return;
      }
      json(response, 404, { error: "Not found" });
    } catch (error) {
      logger.error("http request failed", {
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) json(response, 500, { error: "Internal error" });
      else response.end();
    }
  });

  http.listen(HTTP_PORT, "127.0.0.1", () => {
    logger.info(`demo server on http://127.0.0.1:${HTTP_PORT}`);
    logger.info(`UI: pnpm dev:web (http://127.0.0.1:5173)`);
  });

  const shutdown = async (): Promise<void> => {
    clearInterval(tick);
    http.close();
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
