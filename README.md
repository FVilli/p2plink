# P2PLink

**RPC tipizzate tra browser e servizi Node.js: WebRTC quando possibile, MQTT come fallback.**

P2PLink espone un'API TypeScript unica per richieste ed eventi. L'applicazione non gestisce SDP, ICE, DataChannel, topic MQTT o riconnessioni: il trasporto migliore viene scelto automaticamente.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](tsconfig.base.json)

## Come funziona

```text
Browser / Node client
  ├── WebRTC DataChannel   trasporto preferito, bassa latenza
  └── MQTT                 signaling + fallback
             │
         MQTT broker
             │
      Node.js / NestJS server
```

WebRTC non funziona su ogni rete: NAT simmetrici, CGNAT, firewall e WebView limitano il P2P. In quei casi P2PLink continua a funzionare usando lo stesso broker MQTT come trasporto di fallback.

I frame applicativi e il signaling successivo all'handshake sono cifrati end-to-end. L'handshake scambia solo chiavi pubbliche firmate; il broker trasporta i messaggi ma non può leggerli o modificarli.

## Installazione

```bash
pnpm install
pnpm build
pnpm broker:up    # Mosquitto locale per sviluppo e test
pnpm test
```

Requisiti: Node.js >= 22, pnpm 10 e Docker per il broker di test. I pacchetti non sono ancora pubblicati su npm: per ora si usano dal repository.

Pacchetti principali:

| Pacchetto                                                                 | Ruolo                                                      |
| ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `@p2plink/client` / `@p2plink/server`                                     | API applicativa, bootstrap e gestione sessione             |
| `@p2plink/core` / `@p2plink/crypto` / `@p2plink/mqtt` / `@p2plink/webrtc` | Protocollo, sicurezza e trasporti                          |
| `@p2plink/angular` / `@p2plink/nestjs`                                    | Integrazioni framework                                     |
| `p2plink-registry`                                                        | Servizio opzionale per identità, certificati e utenze MQTT |

## Quick start

### Contratto condiviso tra client e server

```ts
type AppRpc = {
  "users.get": {
    request: { id: string };
    response: { id: string; name: string };
  };
};
```

### Server Node.js

Il server deve esporre un endpoint HTTPS di bootstrap. L'endpoint autentica il token dell'applicazione e restituisce la configurazione MQTT a breve scadenza.

```ts
import { generateIdentity } from "@p2plink/crypto";
import { P2PLinkServer, handleNodeBootstrapRequest } from "@p2plink/server";
import { createNodeWebRtcEngine } from "@p2plink/webrtc/node";

// type AppRpc definito sopra
const server = new P2PLinkServer({
  serverId: "server-1",
  tenant: "default",
  identity: await generateIdentity("server-1", { extractable: true }),
  bootstrap: {
    authenticator: {
      async authenticate({ authorization }) {
        const user = await verifyAppToken(authorization);
        return { subject: user.id, clientId: user.deviceId };
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
    engine: createNodeWebRtcEngine(),
    // iceServers: [{ urls: "stun:stun.example.com:3478" }], // vedi sotto
  },
});

server.register("users.get", async (req) => {
  // register() non è generico: il contratto va annotato/castato nel handler.
  const { id } = req as AppRpc["users.get"]["request"];
  const name = await db.users.name(id);
  return { id, name } satisfies AppRpc["users.get"]["response"];
});

await server.start();

// In un handler o una route HTTP, quando conosci il client:
async function notifyAppointment(context: { clientId: string }) {
  const delivered = await server.emitTo(context.clientId, "appointment.updated", { id: "42" });
  // delivered: boolean — push best-effort, nessuna risposta dal client
  return delivered;
}

// Nel tuo server HTTPS:
// handleNodeBootstrapRequest(server, req, res) su /p2plink/v1/bootstrap
```

### Client browser

```ts
import { createP2PLinkClient, httpBootstrapProvider } from "@p2plink/client";
import { generateIdentity } from "@p2plink/crypto";

// type AppRpc definito sopra
interface AppEvents {
  "appointment.updated": { id: string };
}

const link = createP2PLinkClient<AppRpc, AppEvents>({
  serverId: "server-1",
  bootstrap: httpBootstrapProvider({
    url: "https://api.example.com/p2plink/v1/bootstrap",
    getAccessToken: () => getAppAccessToken(),
  }),
  security: {
    identity: await generateIdentity("device-1", { extractable: true }),
  },
  mqtt: { url: "wss://broker.example.com/mqtt" },
  webrtc: {}, // iceServers si configurano quando servono (vedi sotto)
});

await link.connect();

const user = await link.request("users.get", { id: "42" });
// user: { id: string; name: string } — dedotto da AppRpc, nessun cast
console.log(user.name.toUpperCase());
// payload tipizzato da AppEvents; on() ritorna unsubscribe
link.on("appointment.updated", (payload) => render(payload));
```

In Node.js si usa lo stesso client importando `@p2plink/client/node`.

### STUN e TURN: quando servono

STUN serve per scoprire l'indirizzo pubblico e attraversare NAT non simmetrici; TURN serve per NAT simmetrici/CGNAT o firewall restrittivi. Nella stessa LAN, o quando le candidate host sono raggiungibili, `iceServers` non serve: senza ICE servers WebRTC funziona solo in questi casi. In produzione configura STUN e, se necessario, TURN. Dettagli: [docs/fallback.md](docs/fallback.md) e [packages/webrtc](packages/webrtc/README.md).

`link.on` riceve un evento push da `server.emitTo` (best-effort, senza risposta); `link.request` è domanda/risposta. Il parametro `request` esiste solo nell'handler registrato con `server.register`.

### Angular

```ts
export const appConfig: ApplicationConfig = {
  providers: [
    provideP2PLink(
      {
        serverId: "server-1",
        bootstrap: httpBootstrapProvider({
          url: "/p2plink/v1/bootstrap",
          getAccessToken,
        }),
        security: { identity: loadPersistentIdentity },
        mqtt: { url: "wss://broker.example.com/mqtt" },
      },
      { autoConnect: true },
    ),
  ],
};
```

Lo stato è esposto come Signals e la connessione viene chiusa automaticamente alla distruzione dell'injector. Vedi [docs/angular.md](docs/angular.md).

### NestJS

```ts
@Module({
  imports: [
    P2PLinkModule.forRootAsync({
      useFactory: loadP2PLinkOptions,
      httpBootstrap: true,
    }),
  ],
  providers: [UserRpcHandler],
})
export class AppModule {}

@Injectable()
export class UserRpcHandler {
  @P2PHandler("users.get", { idempotent: true })
  async getUser(request: { id: string }, context: P2PRequestContext) {
    return {
      id: request.id,
      name: "Example",
      requestedBy: context.identity.subject,
    };
  }
}
```

Vedi [docs/nestjs.md](docs/nestjs.md).

## API essenziale

```ts
await link.connect();
const user = await link.request("users.get", { id: "42" }); // AppRpc["users.get"]["response"]
link.on("appointment.updated", (payload) => render(payload)); // push best-effort

const status = link.getStatus();
link.onStatus(listener);
await link.disconnect();
```

- `request()` è domanda/risposta e restituisce una Promise tipizzata; il ritorno dell'handler è la risposta.
- `on()` riceve eventi push best-effort: nessun ACK, retry o risposta.
- `onStatus()` espone trasporto attivo, RTT, stato e ultimo errore.
- `disconnect()` chiude sessione, MQTT, WebRTC e timer.

### Cosa garantisce `await`

Se `await link.request(...)` ritorna, la richiesta è stata consegnata, l'handler è stato eseguito e la risposta è arrivata su un frame cifrato tramite trasporto affidabile (DataChannel o MQTT QoS 1). Anche un handler senza `return` produce `null`, quindi il chiamante si risolve comunque: è prova dell'arrivo della richiesta.

Questo non garantisce exactly-once né un effetto applicativo eseguito una sola volta. Per mutazioni usa `idempotent`/`idempotencyKey` e gestisci gli esiti ambigui:

```ts
import { P2PLinkError } from "@p2plink/core";

try {
  await link.request("orders.create", order, {
    idempotent: true,
    idempotencyKey: order.clientRequestId,
  });
} catch (error) {
  if (error instanceof P2PLinkError && error.code === "OUTCOME_UNKNOWN") {
    // Mutazione: non ritentare automaticamente; risincronizza o verifica lo stato.
  }
  throw error;
}
```

Gli errori sono `P2PLinkError` con `code` (`OFFLINE`, `TIMEOUT`, `OUTCOME_UNKNOWN`, `SESSION_RESET`, ...). Per la semantica completa: [docs/reliability.md](docs/reliability.md).

## Affidabilità e limiti

- Le richieste sono disponibili appena la sessione MQTT è autenticata e il peer è confermato; non si aspetta WebRTC.
- WebRTC viene promosso solo dopo heartbeat cifrati stabili.
- Se WebRTC cade, le nuove richieste passano su MQTT.
- Solo le richieste marcate `idempotent: true` vengono ritentate su un altro trasporto.
- Una richiesta mutativa interrotta può restituire `OUTCOME_UNKNOWN`: non viene ritentata automaticamente.
- Gli eventi push sono **best-effort**: non c'è consegna persistente né exactly-once.
- MQTT QoS 1 non conserva messaggi per peer offline in una sessione `clean`.

Per dati critici servono idempotenza, retry e una risincronizzazione applicativa. Dettagli: [docs/reliability.md](docs/reliability.md).

## Sicurezza

- Il token applicativo viene scambiato via HTTPS e non viaggia su MQTT.
- Handshake con firme ECDSA P-256 e chiavi effimere ECDH P-256.
- Payload cifrati con AES-256-GCM e chiavi separate per trasporto e direzione.
- I frame applicativi e il signaling successivo all'handshake sono cifrati end-to-end: un broker compromesso non può leggerli.
- TLS, autenticazione e ACL del broker restano obbligatori.

L'handshake è specifico di P2PLink e **non è stato sottoposto a un audit crittografico indipendente**. Vedi [docs/security.md](docs/security.md) e [SECURITY.md](SECURITY.md).

## Demo pubbliche

```text
https://p2plink-demo.web.app          vanilla
https://p2plink-demo-angular.web.app  Angular 22
https://p2plink-demo-react.web.app    React 19
```

La mesh demo mostra discovery, ping con verifica SHA-256, traffico P2P/MQTT e fallback. Codice e istruzioni: [demo/](demo/README.md). Immagine backend: `ghcr.io/fvilli/p2plink-demo:latest`.

## Documentazione

- [Architettura](docs/architecture.md)
- [Protocollo](docs/protocol.md)
- [Sicurezza](docs/security.md)
- [Fallback](docs/fallback.md)
- [Affidabilità RPC](docs/reliability.md)
- [Angular](docs/angular.md)
- [NestJS](docs/nestjs.md)
- [Broker MQTT](docs/broker.md)
- [Test](docs/testing.md)
- [Registry](apps/p2plink-registry/README.md)

## Cosa P2PLink non è

Non è un database distribuito, un identity provider, un broker MQTT o un sostituto di Socket.IO/RxDB. Non promette exactly-once, consegna persistente degli eventi o disponibilità offline.

## Licenza

MIT. La dipendenza opzionale `node-datachannel` è distribuita con licenza MPL-2.0; le altre dipendenze principali sono MIT.
