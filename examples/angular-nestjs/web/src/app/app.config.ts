import type { ApplicationConfig } from "@angular/core";
import { provideP2PLink } from "@p2plink/angular";
import { httpBootstrapProvider } from "@p2plink/client";
import { apiBase, loadIdentity } from "./identity.js";

export const appConfig: ApplicationConfig = {
  providers: [
    provideP2PLink(
      {
        serverId: "demo-server",
        tenant: "demo",
        clientId: "client-demo",
        bootstrap: httpBootstrapProvider({
          url: `${apiBase() || location.origin}/p2plink/v1/bootstrap`,
          getAccessToken: () => "demo-token",
          allowInsecureHttp: true,
        }),
        security: { identity: loadIdentity, allowInsecureBootstrap: true },
        mqtt: {
          url: `ws://${location.hostname}:9001`,
          credentials: async () => ({
            username: "client-demo",
            password: "demo-dev-password",
          }),
        },
        webrtc: {
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
      },
      { autoConnect: true },
    ),
  ],
};
