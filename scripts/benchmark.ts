import { arch, cpus, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { generateIdentity } from "@p2plink/crypto";
import { createNodeWebRtcEngine } from "@p2plink/webrtc/node";
import { createP2PLinkClient } from "@p2plink/client/node";

interface BenchRpc {
  "bench.echo": { request: { value: string; pad: string }; response: { value: string } };
}

const brokerUrl = process.env.P2PLINK_BROKER_URL ?? "mqtt://127.0.0.1:1883";
const serverId = "bench-server";
const tenant = "bench";
const port = Number(process.env.BENCH_SERVER_PORT ?? 9100);
const sizes = (process.env.BENCH_SIZES ?? "1,10,100")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

const serverProcess = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "scripts/bench-server.ts"],
  {
    cwd: process.cwd(),
    env: { ...process.env, BENCH_SERVER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverStartMs = 0;
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("benchmark server start timeout")), 30_000);
  serverProcess.stdout.on("data", (data: Buffer) => {
    const text = data.toString();
    const match = /BENCH_SERVER_READY ([\d.]+)/u.exec(text);
    if (!match) return;
    serverStartMs = Number(match[1]);
    clearTimeout(timer);
    resolve();
  });
  serverProcess.stderr.on("data", (data: Buffer) => process.stderr.write(`[server] ${data}`));
  serverProcess.on("exit", (code) => {
    if (serverStartMs === 0) reject(new Error(`benchmark server exited with ${code}`));
  });
});

const clientLogs: string[][] = Array.from({ length: 101 }, () => []);

type Client = ReturnType<typeof createP2PLinkClient<BenchRpc, Record<string, never>>>;

function makeClient(index: number): Client {
  const identityPromise = generateIdentity(`bench-${index}`);
  return createP2PLinkClient<BenchRpc, Record<string, never>>({
    serverId,
    tenant,
    clientId: `client-bench-${index}`,
    bootstrap: {
      async bootstrap(request) {
        const response = await fetch(`http://127.0.0.1:${port}/p2plink/v1/bootstrap`, {
          method: "POST",
          headers: {
            authorization: `Bearer bench-${index}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
        });
        if (!response.ok) throw new Error(`bootstrap failed: HTTP ${response.status}`);
        return (await response.json()) as never;
      },
    },
    security: {
      identity: async () => identityPromise,
    },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message, meta) => clientLogs[index]!.push(`${message} ${JSON.stringify(meta ?? {})}`),
      error: (message, meta) => clientLogs[index]!.push(`${message} ${JSON.stringify(meta ?? {})}`),
    },
    mqtt: { url: brokerUrl },
    webrtc: {
      engine: createNodeWebRtcEngine(),
      iceServers: [],
      reconnect: { baseDelayMs: 200, maxDelayMs: 2_000, maxAttempts: 20 },
    },
    limits: {
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 4_000,
      promoteAfterMs: 1_000,
      requestTimeoutMs: 15_000,
      maxPendingRequests: 64,
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<number> {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return performance.now() - started;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

const results = [];
for (const size of sizes) {
  const clients = Array.from({ length: size }, (_, index) => makeClient(index + 1));
  const connectDurations: number[] = [];
  const t0 = performance.now();
  const clientCpuStart = process.cpuUsage();
  const statsStart = (await fetch(`http://127.0.0.1:${port}/stats`).then((r) => r.json())) as {
    rss: number;
    heapUsed: number;
    cpu: { user: number; system: number };
  };
  await Promise.all(
    clients.map(async (client) => {
      const started = performance.now();
      await client.connect();
      connectDurations.push(performance.now() - started);
    }),
  );
  const connectAllMs = performance.now() - t0;

  const p2pStarted = performance.now();
  await waitFor(
    () => clients.every((client) => client.getStatus().transport === "webrtc"),
    120_000,
  ).catch(async (error: unknown) => {
    const statuses = new Map<string, number>();
    for (const client of clients) {
      const snapshot = client.getStatus();
      const key = `${snapshot.status}/${snapshot.transport ?? "-"}/${snapshot.lastError?.code ?? "ok"}`;
      statuses.set(key, (statuses.get(key) ?? 0) + 1);
    }
    console.error("[bench] p2p timeout statuses", Object.fromEntries(statuses));
    const stats = (await fetch(`http://127.0.0.1:${port}/stats`).then((r) => r.json())) as {
      sessions: Array<{ transport: string | null }>;
    };
    console.error(
      "[bench] server sessions",
      stats.sessions.length,
      stats.sessions.filter((s) => s.transport === "webrtc").length,
    );
    const stuck = clients
      .map((client, index) => ({ client, index }))
      .filter(({ client }) => client.getStatus().transport !== "webrtc")
      .slice(0, 5);
    for (const { index } of stuck)
      console.error("[bench] client log", index + 1, clientLogs[index + 1]?.slice(-15));
    throw error;
  });
  const p2pAllMs = performance.now() - p2pStarted;

  const rpcSamples: number[] = [];
  const rpcStarted = performance.now();
  await Promise.all(
    clients.map(async (client) => {
      for (let i = 0; i < 5; i += 1) {
        const started = performance.now();
        await client.request("bench.echo", { value: `c${i}`, pad: "x".repeat(1024) });
        rpcSamples.push(performance.now() - started);
      }
    }),
  );
  const rpcWallMs = performance.now() - rpcStarted;

  const probe = clients[0]!;
  const dropStarted = performance.now();
  await fetch(
    `http://127.0.0.1:${port}/drop?clientId=${encodeURIComponent(probe.getStatus().clientId ?? "client-bench-1")}`,
    { method: "POST" },
  );
  await waitFor(() => probe.getStatus().transport === "mqtt", 30_000);
  const fallbackMs = performance.now() - dropStarted;

  const mqttRpc: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    await probe.request("bench.echo", { value: "mqtt", pad: "" });
    mqttRpc.push(performance.now() - started);
  }

  const restoreStarted = performance.now();
  await waitFor(() => probe.getStatus().transport === "webrtc", 60_000);
  const restoreMs = performance.now() - restoreStarted;

  const memory = process.memoryUsage();
  const cpu = process.cpuUsage(clientCpuStart);
  const elapsed = performance.now() - t0;
  const cpuPercent = ((cpu.user + cpu.system) / 1000 / elapsed) * 100;
  const statsEnd = (await fetch(`http://127.0.0.1:${port}/stats`).then((r) => r.json())) as {
    rss: number;
    heapUsed: number;
    cpu: { user: number; system: number };
  };
  const serverCpuPercent =
    ((statsEnd.cpu.user + statsEnd.cpu.system - (statsStart.cpu.user + statsStart.cpu.system)) /
      1000 /
      elapsed) *
    100;

  results.push({
    clients: size,
    connectAllMs: Math.round(connectAllMs),
    connectMedianMs: Math.round(percentile(connectDurations, 50)),
    connectP95Ms: Math.round(percentile(connectDurations, 95)),
    p2pAllMs: Math.round(p2pAllMs),
    rpcP2pAvgMs: Number((rpcSamples.reduce((a, b) => a + b, 0) / rpcSamples.length).toFixed(2)),
    rpcP2pP95Ms: Number(percentile(rpcSamples, 95).toFixed(2)),
    rpcP2pWallMs: Math.round(rpcWallMs),
    rpcMqttAvgMs: Number((mqttRpc.reduce((a, b) => a + b, 0) / mqttRpc.length).toFixed(2)),
    fallbackMs: Math.round(fallbackMs),
    restoreMs: Math.round(restoreMs),
    clientRssMB: Math.round(memory.rss / 1024 / 1024),
    clientHeapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
    clientCpuPercent: Number(cpuPercent.toFixed(1)),
    serverRssMB: Math.round(statsEnd.rss / 1024 / 1024),
    serverHeapUsedMB: Math.round(statsEnd.heapUsed / 1024 / 1024),
    serverCpuPercent: Number(serverCpuPercent.toFixed(1)),
  });

  process.stderr.write(`[bench] ${size} clients done\n`);
  await Promise.all(clients.map((client) => client.disconnect()));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

serverProcess.kill("SIGTERM");
await new Promise((resolve) => serverProcess.on("exit", resolve));

const output = {
  measuredAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    totalMemoryGB: Math.round(totalmem() / 1024 / 1024 / 1024),
    broker: "eclipse-mosquitto:2 (2.1.2), local Docker",
    serverStartMs: Math.round(serverStartMs),
    transports: "loopback, no STUN/TURN",
  },
  results,
};
console.log(JSON.stringify(output, null, 2));
