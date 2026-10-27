# P2PLink

**Una sola API TypeScript per comunicazioni bidirezionali affidabili tra browser e servizi Node.js: WebRTC quando funziona, MQTT quando serve.**

P2PLink usa lo stesso broker MQTT per il signaling WebRTC e come trasporto di fallback. L'applicazione chiama metodi RPC tipizzati e riceve eventi; non conosce SDP, ICE, DataChannel, topic o riconnessioni.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](tsconfig.base.json)

---

## Perché esiste

WebRTC offre un canale diretto, a bassa latenza, senza porte aperte sul router. Non funziona sempre: NAT simmetrici, CGNAT, reti mobili, WebView sospese e firewall possono impedirlo. MQTT è già spesso presente come infrastruttura e può trasportare gli stessi messaggi applicativi quando il canale diretto non è disponibile.

P2PLink unisce i due mondi:

- **WebRTC DataChannel** come trasporto preferito.
- **MQTT** per signaling e fallback.
- **Crittografia end-to-end** sopra entrambi i trasporti.
- **RPC tipizzate**, timeout, idempotenza ed eventi push.
- **Fallback automatico** senza duplicare operazioni.
- **Ripristino P2P automatico** con backoff e isteresi.

Nessun PeerServer, Socket.IO, Firebase o RxDB richiesto. TURN è supportato tramite `iceServers` ma non è necessario per il funzionamento minimo.

## Architettura

```mermaid
flowchart LR
  subgraph Browser
    APP[Angular / Web App]
    CLIENT[@p2plink/client]
    SEC[E2E Crypto]
    RTC[WebRTC DataChannel]
    MQ[MQTT.js WSS]
  end

  subgraph Broker
    MQTT[(MQTT broker<br/>signaling + fallback)]
  end

  subgraph Server
    NEST[NestJS / Node]
    SRV[@p2plink/server]
    SSEC[E2E Crypto]
    SRTC[WebRTC answerer]
    SMQ[MQTT.js]
  end

  APP --> CLIENT
  CLIENT --> SEC
  SEC --> RTC
  SEC --> MQ
  RTC <-->|preferred: DTLS + E2E AES-GCM| SRTC
  MQ <-->|signaling + fallback| MQTT
  MQTT <-->|signaling + fallback| SMQ
  SMQ --> SSEC
  SSEC --> SRV
  SRV --> NEST
  SRTC --> SSEC
```

Il signaling WebRTC viaggia **cifrato e autenticato** dentro la sessione MQTT: il broker non può riscrivere SDP o ICE. Il DataChannel viene considerato utilizzabile solo dopo heartbeat applicativi cifrati che provano la chiave di sessione.

## Pacchetti

| Pacchetto          | Ruolo                                                                             |
| ------------------ | --------------------------------------------------------------------------------- |
| `@p2plink/core`    | Protocollo, envelope, codec, transport manager, RPC, idempotenza, errori, limiti  |
| `@p2plink/crypto`  | Identità ECDSA P-256, handshake ECDH autenticato, HKDF, AES-GCM, replay window    |
| `@p2plink/mqtt`    | Connessione MQTT.js, endpoint client/server, ACL-ready topics, trasporto fallback |
| `@p2plink/webrtc`  | Engine WebRTC browser/Node, DataChannel, signaling, chunking, backpressure        |
| `@p2plink/client`  | API applicativa browser e Node, bootstrap HTTPS, fallback/recovery                |
| `@p2plink/server`  | Sessioni multi-client, bootstrap, capability, RPC handler, WebRTC answerer        |
| `@p2plink/angular` | Provider standalone, Signals, lifecycle automatico                                |
| `@p2plink/nestjs`  | Dynamic module, `@P2PHandler`, discovery, graceful shutdown                       |

> **Stato npm:** i nomi sono stati verificati disponibili sul registry, ma **nessun pacchetto è stato pubblicato**. Le istruzioni di build e pack sono in [docs/testing.md](docs/testing.md).

## Installazione (dal repository)

```bash
pnpm install
pnpm build
pnpm broker:up      # Mosquitto 2 con TCP 1883 e WebSocket 9001
pnpm test           # unit + integrazione (richiede il broker)
```

Requisiti: Node.js >= 22 (testato su 24.19), pnpm 10, Docker per il broker di test. La demo Angular 22 richiede Node >= 24.15, come dichiarato da Angular. Node.js usa `node-datachannel` per WebRTC; i binari precompilati coprono Linux x64/arm64, macOS e Windows.

## Quick start

### Server Node.js

Il server deve esporre un endpoint di bootstrap **HTTPS** che autentica l'applicazione e restituisce una capability monouso, credenziali MQTT a breve scadenza e la chiave pubblica del server.

```ts
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { generateIdentity } from "@p2plink/crypto";
import { createNodeWebRtcEngine } from "@p2plink/webrtc/node";
import { P2PLinkServer, handleNodeBootstrapRequest } from "@p2plink/server";

const identity = await generateIdentity("server-1", { extractable: true });
const server = new P2PLinkServer({
  serverId: "server-1",
  tenant: "default",
  identity,
  bootstrap: {
    authenticator: {
      async authenticate({ authorization }) {
        // Verifica il token della tua applicazione (JWT, sessione, initData, ...).
        const user = await verifyAppToken(authorization);
        return { subject: user.id, clientId: user.deviceId, claims: { role: user.role } };
      },
    },
    mqttCredentials: async ({ clientId }) => ({
      url: "wss://broker.example.com/mqtt",
      username: clientId,
      password: await issueShortLivedBrokerPassword(clientId),
    }),
  },
  mqtt: {
    url: "mqtts://broker.example.com:8883",
    username: "p2plink-server",
    password: process.env.MQTT_SERVER_PASSWORD,
  },
  webrtc: {
    enabled: true,
    engine: createNodeWebRtcEngine(),
    iceServers: [{ urls: "stun:stun.example.com:3478" }],
  },
});

server.register("users.get", async (request, context) => {
  const { id } = request as { id: string };
  return { id, name: await db.users.name(id) };
});

await server.start();

createServer(
  {
    key: readFileSync("/etc/p2plink/tls/key.pem"),
    cert: readFileSync("/etc/p2plink/tls/cert.pem"),
  },
  (req, res) => {
    if (req.url === "/p2plink/v1/bootstrap") {
      void handleNodeBootstrapRequest(server, req, res);
    } else {
      res.writeHead(404).end();
    }
  },
).listen(443);
```

### Client browser

```ts
import { createP2PLinkClient, httpBootstrapProvider } from "@p2plink/client";
import { generateIdentity } from "@p2plink/crypto";

interface AppRpc {
  "users.get": {
    request: { id: string };
    response: { id: string; name: string };
  };
}

const identity = await generateIdentity("device-1", { extractable: true });

const link = createP2PLinkClient<AppRpc>({
  serverId: "server-1",
  bootstrap: httpBootstrapProvider({
    url: "https://api.example.com/p2plink/v1/bootstrap",
    getAccessToken: () => getAppAccessToken(),
  }),
  security: { identity },
  mqtt: { url: "wss://broker.example.com/mqtt" },
  webrtc: {
    // STUN esplicito: nessun server pubblico viene usato implicitamente.
    iceServers: [{ urls: "stun:stun.example.com:3478" }],
  },
});

await link.connect();

link.onStatus((status) => {
  console.log(status.status, status.transport, status.rttMs);
});

const user = await link.request("users.get", { id: "42" });
link.on("appointment.updated", (event) => render(event));
```

L'API è la stessa in Node.js importando `@p2plink/client/node`.

### Server → client push

```ts
await server.emitTo("device-1", "appointment.updated", { id: "a-1" });
```

Gli eventi sono **best-effort**: non c'è consegna persistente né exactly-once. Per dati critici usare una RPC idempotente e una risincronizzazione applicativa.

## Angular

```ts
import { ApplicationConfig } from "@angular/core";
import { provideP2PLink } from "@p2plink/angular";

export const appConfig: ApplicationConfig = {
  providers: [
    provideP2PLink(
      {
        serverId: "server-1",
        bootstrap: httpBootstrapProvider({ url: "/p2plink/v1/bootstrap", getAccessToken }),
        security: { identity: loadPersistentIdentity },
        mqtt: { url: "wss://broker.example.com/mqtt" },
        webrtc: { iceServers: [{ urls: "stun:stun.example.com:3478" }] },
      },
      { autoConnect: true },
    ),
  ],
};
```

```ts
@Injectable({ providedIn: "root" })
export class UsersService {
  private readonly link = inject(P2PLinkService) as P2PLinkService<AppRpc>;

  readonly status = this.link.status;
  readonly isP2P = this.link.isP2P;

  getUser(id: string) {
    return this.link.request("users.get", { id });
  }
}
```

Lo stato è esposto con Signals. La connessione viene chiusa automaticamente alla distruzione dell'injector. Vedi [docs/angular.md](docs/angular.md).

## NestJS

```ts
@Module({
  imports: [
    P2PLinkModule.forRootAsync({
      useFactory: loadP2PLinkOptions,
      httpBootstrap: true, // POST /p2plink/v1/bootstrap
    }),
  ],
  providers: [UserRpcHandler],
})
export class AppModule {}
```

```ts
@Injectable()
export class UserRpcHandler {
  @P2PHandler("users.get", { idempotent: true })
  async getUser(request: { id: string }, context: P2PRequestContext) {
    // context.identity.subject è verificato dal server, non dichiarato dal client.
    return { id: request.id, name: "Example", requestedBy: context.identity.subject };
  }
}
```

Il modulo scopre gli handler con `DiscoveryService`, gestisce molti client con una sola infrastruttura MQTT e chiude le sessioni su `onApplicationShutdown`. Vedi [docs/nestjs.md](docs/nestjs.md).

## Configurazione essenziale

```ts
interface P2PLinkClientConfig {
  serverId: string;
  tenant?: string; // default: "default"
  clientId?: string; // richiesto o assegnato dal bootstrap
  bootstrap: BootstrapProvider; // HTTPS, obbligatorio
  mqtt?: {
    url?: string; // può arrivare dal bootstrap
    credentials?: () => Promise<{ username?: string; password?: string; url?: string }>;
  };
  webrtc?: {
    enabled?: boolean; // default: true
    iceServers?: IceServer[]; // default: [] (nessuno STUN implicito)
    engine?: WebRtcEngine; // override per test/runtime
    reconnect?: {
      baseDelayMs?: number;
      maxDelayMs?: number;
      maxAttempts?: number;
      jitter?: number;
    };
  };
  security?: {
    identity?: ClientIdentity | (() => Promise<ClientIdentity>);
    serverIdentity?: { publicKeyJwk?: JsonWebKey; fingerprint?: string };
    clockSkewMs?: number;
  };
  limits?: Partial<P2PLinkLimits>;
  logger?: Logger;
}
```

Limiti predefiniti principali: payload 64 KiB, frame 256 KiB, 64 richieste pendenti, timeout RPC 15 s, heartbeat 5 s, timeout heartbeat 15 s, cooldown cambio trasporto 5 s, sessione idle 120 s, 500 sessioni server.

## Fallback e stato

```ts
type ConnectionStatus = "connecting" | "p2p" | "mqtt" | "offline" | "reconnecting" | "closed";
```

- Le richieste sono utilizzabili appena la sessione MQTT è autenticata e verificata: non si aspetta WebRTC.
- WebRTC viene promosso solo dopo heartbeat cifrati stabili.
- Se il DataChannel cade, le nuove richieste passano su MQTT; le richieste in-flight restano in attesa fino al timeout.
- Solo le richieste marcate `idempotent: true` vengono ritrasmesse su un altro trasporto.
- Le richieste mutative interrotte falliscono con `OUTCOME_UNKNOWN`, non con un falso fallimento definitivo.
- Se MQTT cade ma WebRTC è sano, il traffico P2P continua e MQTT viene ritentato in background.
- Il ripristino P2P usa backoff esponenziale con jitter e un cooldown anti-flapping.

Dettagli: [docs/fallback.md](docs/fallback.md).

## Sicurezza in breve

- Il token applicativo **non viaggia mai su MQTT**: viene scambiato via HTTPS con una capability monouso legata all'identità del client.
- La sessione è autenticata con firme ECDSA P-256 e chiavi effimere ECDH P-256.
- Le chiavi AES-256-GCM sono separate per trasporto e direzione (`mqtt/c2s`, `mqtt/s2c`, `webrtc/c2s`, `webrtc/s2c`).
- Nonce = prefisso casuale + contatore 64 bit; AAD lega versione, trasporto, sessione e contatore; replay window di 1024 frame.
- Signaling SDP/ICE e frame applicativi sono cifrati end-to-end: un broker compromesso non può leggerli né alterarli.
- Il broker deve comunque avere TLS, autenticazione e ACL: la cifratura dei payload **non sostituisce** l'autorizzazione del broker.

La crittografia usa primitive standard WebCrypto, ma il protocollo di handshake è specifico di P2PLink e **non è stato sottoposto a un audit crittografico indipendente**. Non usarlo per dati ad altissimo rischio senza una revisione. Vedi [docs/security.md](docs/security.md) e [SECURITY.md](SECURITY.md).

## Broker MQTT

Configurazione Mosquitto di sviluppo inclusa:

```bash
pnpm broker:up
# tcp://127.0.0.1:1883, ws://127.0.0.1:9001
# utenti demo: p2plink-server / server-dev-password, client-demo / demo-dev-password
```

Topic:

```text
p2plink/v1/{tenant}/{serverId}/session/{clientId}/c2s
p2plink/v1/{tenant}/{serverId}/session/{clientId}/s2c
p2plink/v1/{tenant}/{serverId}/signal/{clientId}/s2c   # solo session-reset, nessun segreto
```

ACL least-privilege, TLS/WSS, credenziali dinamiche e limiti broker: [docs/broker.md](docs/broker.md).

## Esempi eseguibili

### Browser ↔ Node.js

```bash
pnpm broker:up
pnpm --filter @p2plink/example-browser-node dev
# UI: http://127.0.0.1:5173
```

Mostra stato trasporto, RTT, RPC, eventi, guasto P2P simulato, fallback MQTT, ripristino P2P e sospensione/ripresa della rete.

### Mesh demo (broker come unico singleton)

La demo dedicata in [demo/](demo/README.md) mostra frontend e backend NestJS come peer equivalenti: discovery, ping a rotazione, integrità SHA-256, traffico P2P/MQTT e rate per peer.

```bash
pnpm demo:build
pnpm --dir demo broker:up
pnpm --dir demo dev:web
# in altri terminali, uno o più backend:
MQTT_URL=mqtt://127.0.0.1:1884 MQTT_USERNAME=demo MQTT_PASSWORD=demo-pass \
PEER_NAME=nest-1 PORT=3100 PING_BYTES=2048 pnpm --dir demo dev:backend
```

### Angular ↔ NestJS

```bash
pnpm broker:up
pnpm --filter @p2plink/example-angular-web build
pnpm --filter @p2plink/example-nest-server build
pnpm --filter @p2plink/example-nest-server start
# UI production build: http://127.0.0.1:3000
```

La demo usa Angular 22 con Signals e NestJS 12, con build di produzione verificata. Vedi [examples/angular-nestjs](examples/angular-nestjs).

## Test e benchmark

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
node scripts/browser-demo-check.mjs      # servizi demo avviati
node scripts/angular-demo-check.mjs      # Nest demo avviato
pnpm exec tsx scripts/benchmark.ts       # 1, 10, 100 client
```

Risultati misurati su questa macchina (loopback, broker locale, server in processo separato): [docs/benchmark.md](docs/benchmark.md). Copertura e limiti: [docs/testing.md](docs/testing.md).

## Cosa P2PLink non è

Non è un database distribuito, un sostituto di RxDB, un framework di microservizi, un identity provider, un broker MQTT o una piattaforma SaaS. Non promette exactly-once, consegna persistente degli eventi, disponibilità offline o che WebRTC attraversi ogni NAT.

## Roadmap

- Audit crittografico indipendente dell'handshake e del formato capability.
- TURN opzionale e ICE restart esplicito con accumulo statistiche.
- Codec binari opzionali (CBOR/MessagePack) se misurano un vantaggio reale.
- Credenziali MQTT dinamiche pronte all'uso per EMQX JWT e Mosquitto Dynamic Security.
- Test Firefox/WebKit e WebView Telegram su dispositivi reali.
- Store di idempotenza SQLite/Postgres con transazioni applicative documentate.
- Metriche OpenTelemetry opzionali.

## Documentazione

- [Valutazione tecnologica](docs/technology-evaluation.md)
- [Architettura](docs/architecture.md)
- [Protocollo](docs/protocol.md)
- [Signaling](docs/signaling.md)
- [Sicurezza e threat model](docs/security.md)
- [Fallback](docs/fallback.md)
- [Affidabilità RPC](docs/reliability.md)
- [Angular](docs/angular.md)
- [NestJS](docs/nestjs.md)
- [Broker MQTT](docs/broker.md)
- [Test](docs/testing.md)
- [Benchmark](docs/benchmark.md)
- [Decisioni architetturali](docs/decisions.md)
- [Release](docs/release.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Licenza

MIT. La dipendenza opzionale `node-datachannel` è distribuita con licenza MPL-2.0; `werift`, MQTT.js, Angular e NestJS sono MIT. Nessun codice di terze parti è stato copiato in P2PLink. Dettagli in [docs/technology-evaluation.md](docs/technology-evaluation.md).
