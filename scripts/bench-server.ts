import { createServer } from "node:http";
import { generateIdentity } from "@p2plink/crypto";
import { createNodeWebRtcEngine } from "@p2plink/webrtc/node";
import { P2PLinkServer, handleNodeBootstrapRequest } from "@p2plink/server";

const brokerUrl = process.env.P2PLINK_BROKER_URL ?? "mqtt://127.0.0.1:1883";
const port = Number(process.env.BENCH_SERVER_PORT ?? 9100);

const server = new P2PLinkServer({
  serverId: "bench-server",
  tenant: "bench",
  identity: await generateIdentity("bench-server"),
  bootstrap: {
    authenticator: {
      async authenticate({ authorization }) {
        const match = /^Bearer bench-(\d+)$/u.exec(authorization ?? "");
        if (!match) throw new Error("invalid benchmark token");
        return { subject: `bench-user-${match[1]}`, clientId: `client-bench-${match[1]}` };
      },
    },
    mqttCredentials: async ({ clientId }) => ({
      url: brokerUrl,
      username: clientId,
      password: "bench-dev-password",
    }),
    maxRequestsPerMinute: 10_000,
  },
  mqtt: {
    url: brokerUrl,
    username: "p2plink-server",
    password: "server-dev-password",
    clientId: "p2plink-benchmark-server",
  },
  webrtc: { enabled: true, engine: createNodeWebRtcEngine(), iceServers: [] },
  limits: {
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 4_000,
    promoteAfterMs: 1_000,
    requestTimeoutMs: 15_000,
    sessionIdleTimeoutMs: 300_000,
    maxSessions: 500,
    maxHandshakes: 200,
    rateLimitPerSecond: 200,
  },
});
server.register("bench.echo", (request) => ({ value: (request as { value: string }).value }));

const start = performance.now();
await server.start();
const startMs = performance.now() - start;

const http = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/p2plink/v1/bootstrap") {
    await handleNodeBootstrapRequest(server, request, response);
    return;
  }
  if (url.pathname === "/stats") {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        cpu,
        sessions: server.getSessionInfo(),
      }),
    );
    return;
  }
  if (url.pathname === "/drop" && request.method === "POST") {
    const clientId = url.searchParams.get("clientId") ?? "";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ dropped: await server.dropP2P(clientId) }));
    return;
  }
  response.writeHead(404);
  response.end();
});
http.listen(port, "127.0.0.1", () => {
  console.log(`BENCH_SERVER_READY ${startMs.toFixed(1)}`);
});

const shutdown = async (): Promise<void> => {
  http.close();
  await server.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
