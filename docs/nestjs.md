# NestJS

Package: `@p2plink/nestjs` (NestJS 12, ESM; build dual ESM/CJS).

## Modulo

```ts
import { Module } from "@nestjs/common";
import { P2PLinkModule } from "@p2plink/nestjs";
import { loadP2PLinkOptions } from "./p2plink.config.js";

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
```

Configurazione sincrona:

```ts
P2PLinkModule.forRoot({
  serverId: "server-1",
  tenant: "default",
  identity,
  bootstrap: { authenticator, mqttCredentials },
  mqtt: { url: "mqtts://broker:8883", username: "p2plink-server", password },
  webrtc: { enabled: true, engine: createNodeWebRtcEngine(), iceServers },
  httpBootstrap: true,
  autoStart: true,
});
```

`forRootAsync` accetta `imports`, `inject`, `useFactory`, `global`, `httpBootstrap`. Il modulo importa `DiscoveryModule` e fornisce:

- `P2PLINK_SERVER` → `P2PLinkServer`
- `P2PLinkRegistry` → discovery + lifecycle
- `P2PLinkBootstrapController` (se `httpBootstrap: true`)

Esporta `P2PLINK_SERVER` e `P2PLinkRegistry`.

## Handler

```ts
import { Injectable, Inject } from "@nestjs/common";
import { P2PHandler, P2PRequestContext, P2PLINK_SERVER } from "@p2plink/nestjs";
import type { P2PLinkServer } from "@p2plink/server";

@Injectable()
export class UserRpcHandler {
  constructor(@Inject(P2PLINK_SERVER) private readonly server: P2PLinkServer) {}

  @P2PHandler("users.get")
  async getUser(request: { id: string }, context: P2PRequestContext) {
    return {
      id: request.id,
      name: await this.users.name(request.id),
      requestedBy: context.identity.subject,
    };
  }

  @P2PHandler("orders.create", { idempotent: true, timeoutMs: 10_000 })
  async createOrder(request: CreateOrder, context: P2PRequestContext) {
    const order = await this.orders.create(request, context.identity);
    await this.server.emitTo(context.clientId, "orders.updated", { id: order.id });
    return order;
  }
}
```

`@P2PHandler(method, options)` registra il metodo. Il registry scopre gli handler con `DiscoveryService` + `MetadataScanner` + `Reflector`, quindi il provider deve essere nel modulo (o importato/esportato da un modulo visibile a Nest).

Opzioni: `timeoutMs`, `idempotent`.

## Contesto

```ts
interface P2PRequestContext {
  identity: {
    subject: string; // verificato dalla capability/token
    identityId: string;
    publicKeyJwk: JsonWebKey;
    claims?: JsonObject; // claim autorizzati dall'app
  };
  clientId: string; // topic + capability
  sessionId: string;
  serverId: string;
  requestId: string;
  method: string;
  transport: "mqtt" | "webrtc";
  signal: AbortSignal;
}
```

`identity` non contiene dati di autenticazione grezzi non verificati. Il client non può scegliere il proprio `subject` o i propri claim: arrivano dal bootstrap autenticato e dalla capability firmata.

## Autorizzazione

L'autorizzazione è applicativa:

```ts
@Module({
  imports: [
    P2PLinkModule.forRoot({
      // ...
      authorize: async (context) => {
        if (context.method.startsWith("admin.") && context.identity.claims?.role !== "admin") {
          throw new P2PLinkError("FORBIDDEN", "Admin only");
        }
      },
    }),
  ],
})
export class AppModule {}
```

Oppure dentro l'handler. P2PLink non inventa ruoli o regole di dominio. L'`AbortSignal` viene annullato al timeout o alla chiusura della sessione; gli handler dovrebbero propagarlo a query/HTTP client.

## Bootstrap HTTP

Con `httpBootstrap: true` viene registrato:

```text
POST /p2plink/v1/bootstrap
Authorization: Bearer <token applicativo>
Content-Type: application/json
```

Il controller chiama `P2PLinkServer.handleBootstrap` e restituisce 200 o un errore HTTP generico. In produzione:

- esporre solo su HTTPS;
- applicare rate limiting a monte;
- non loggare il token;
- restituire credenziali MQTT a breve scadenza;
- se il bootstrap è su un dominio diverso dal frontend, configurare CORS in modo restrittivo.

## Graceful shutdown

`P2PLinkRegistry` implementa `OnApplicationShutdown` e chiama `server.stop()`, che chiude sessioni, peer WebRTC, endpoint MQTT e connessione. Abilitare:

```ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
```

## Molti client, una sola infrastruttura

- Una connessione MQTT server condivisa.
- Una sottoscrizione wildcard.
- Una sessione per clientId con il proprio TransportManager e peer WebRTC.
- Un solo `RpcServer` e un solo store di idempotenza condiviso (chiavi scoped per identità).
- Nessuna istanza NestJS per client.

Limiti: `maxSessions`, `maxHandshakes`, `sessionIdleTimeoutMs`, `rateLimitPerSecond`, `maxPendingRequests` in `limits`.

## Note di build

- NestJS 12 è ESM. `@p2plink/nestjs` è prodotto ESM+CJS.
- Il registry usa `@Inject(...)` espliciti per `DiscoveryService`, `MetadataScanner` e `Reflector`, così l'iniezione non dipende da `emitDecoratorMetadata` del consumer.
- Gli handler applicativi possono comunque usare la normale iniezione NestJS.
- La demo compila con `tsc` e gira su Node 24.

## Esempio completo

`examples/angular-nestjs/server` contiene:

- `P2PLinkModule.forRootAsync({ httpBootstrap: true })`;
- `DataHandlers` con `@P2PHandler`;
- un `DebugController` con `/debug/drop-p2p`, `/debug/emit`, `/debug/info`;
- static serving della build Angular;
- graceful shutdown.

Avvio:

```bash
pnpm --filter @p2plink/example-angular-web build
pnpm --filter @p2plink/example-nest-server build
pnpm --filter @p2plink/example-nest-server start
```
