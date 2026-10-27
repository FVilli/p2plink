import { createNodeWebRtcEngine } from "@p2plink/webrtc/node";
import type { P2PLinkModuleOptions } from "@p2plink/nestjs";
import { loadServerIdentity } from "./identity.js";

const brokerTcp = process.env.MQTT_URL ?? "mqtt://127.0.0.1:1883";
const brokerWs = process.env.MQTT_WS_URL ?? "ws://127.0.0.1:9001";

export async function loadP2PLinkOptions(): Promise<P2PLinkModuleOptions> {
  const identity = await loadServerIdentity();
  return {
    serverId: "demo-server",
    tenant: "demo",
    identity,
    autoStart: true,
    httpBootstrap: true,
    bootstrap: {
      authenticator: {
        async authenticate({ authorization }) {
          if (authorization !== `Bearer ${process.env.DEMO_TOKEN ?? "demo-token"}`) {
            throw new Error("Invalid demo token");
          }
          return { subject: "demo-user", clientId: "client-demo", claims: { role: "admin" } };
        },
      },
      mqttCredentials: async ({ clientId }) => ({
        url: brokerWs,
        username: clientId,
        password: "demo-dev-password",
      }),
      maxRequestsPerMinute: 60,
    },
    mqtt: {
      url: brokerTcp,
      username: "p2plink-server",
      password: "server-dev-password",
      clientId: "p2plink-nest-demo",
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
    logger: {
      debug: (message, meta) => console.debug(`[p2plink] ${message}`, meta ?? ""),
      info: (message, meta) => console.info(`[p2plink] ${message}`, meta ?? ""),
      warn: (message, meta) => console.warn(`[p2plink] ${message}`, meta ?? ""),
      error: (message, meta) => console.error(`[p2plink] ${message}`, meta ?? ""),
    },
  };
}
