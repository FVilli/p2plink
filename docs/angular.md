# Angular

Package: `@p2plink/angular` (Angular 22, standalone, Signals, zoneless-friendly). Angular 22 richiede Node.js >= 24.15.

## Installazione nel monorepo

```bash
pnpm --filter @p2plink/client build
pnpm --filter @p2plink/angular build
```

La build usa ng-packagr 22 in modalità partial-Ivy. Il pacchetto pubblicabile è `packages/angular/dist`.

## Provider

```ts
import { ApplicationConfig } from "@angular/core";
import { provideP2PLink } from "@p2plink/angular";
import { httpBootstrapProvider } from "@p2plink/client";

export const appConfig: ApplicationConfig = {
  providers: [
    provideP2PLink(
      {
        serverId: "server-1",
        tenant: "default",
        clientId: "device-1",
        bootstrap: httpBootstrapProvider({
          url: "/p2plink/v1/bootstrap",
          getAccessToken: () => getAccessToken(),
        }),
        security: { identity: loadPersistentIdentity },
        mqtt: { url: "wss://broker.example.com/mqtt" },
        webrtc: {
          iceServers: [{ urls: "stun:stun.example.com:3478" }],
        },
      },
      { autoConnect: true },
    ),
  ],
};
```

`provideP2PLink` restituisce `EnvironmentProviders`: va inserito direttamente nei provider dell'ambiente, non spalmato in un array di `Provider`.

Per test o client custom:

```ts
provideP2PLinkClient(myClient, { autoConnect: false });
```

## Service

```ts
import { Injectable, inject } from "@angular/core";
import { P2PLinkService } from "@p2plink/angular";

interface AppRpc {
  "users.get": {
    request: { id: string };
    response: { id: string; name: string };
  };
}

@Injectable({ providedIn: "root" })
export class UsersService {
  private readonly link = inject(P2PLinkService) as P2PLinkService<AppRpc>;

  readonly status = this.link.status;
  readonly isP2P = this.link.isP2P;
  readonly rtt = this.link.rttMs;

  getUser(id: string) {
    return this.link.request("users.get", { id });
  }
}
```

Signal esposti:

| Signal             | Tipo                                       |
| ------------------ | ------------------------------------------ |
| `status`           | `ConnectionSnapshot` completo              |
| `connectionStatus` | `ConnectionStatus`                         |
| `transport`        | `"webrtc" \| "mqtt" \| null`               |
| `rttMs`            | `number \| null`                           |
| `pendingRequests`  | `number`                                   |
| `sessionId`        | `string \| null`                           |
| `lastError`        | `SerializedError \| null`                  |
| `isConnected`      | `boolean`                                  |
| `isP2P`            | `boolean`                                  |
| `error`            | `P2PLinkError \| null` (da connect/resume) |

Metodi: `connect`, `disconnect`, `suspend`, `resume`, `request`, `on`.

## Template

```html
<span [attr.data-status]="link.connectionStatus()"> {{ link.connectionStatus() }} </span>

@if (link.isP2P()) {
<p>Collegamento diretto ({{ link.rttMs() }} ms)</p>
} @else {
<p>Trasporto MQTT</p>
} @for (user of users(); track user.id) {
<li>{{ user.name }}</li>
}
```

Aggiornare un Signal da un listener P2PLink è sufficiente in Angular zoneless: il change detection viene pianificato dal framework.

## Lifecycle

- Il service è `providedIn: "root"`.
- Alla creazione si sottoscrive a `onStatus` e aggiorna `status`.
- Con `autoConnect` (default true) chiama `connect()` in un microtask, fuori dal costruttore sincrono.
- `DestroyRef.onDestroy` rimuove la sottoscrizione e chiama `disconnect()`.
- Errori di connessione automatica finiscono in `error`, senza unhandled rejection.

## Identity persistence

`generateIdentity()` di default produce una chiave non estraibile. Per una identità stabile tra reload:

```ts
async function loadPersistentIdentity() {
  const stored = localStorage.getItem("device-identity");
  if (stored) return importIdentity(JSON.parse(stored));
  const identity = await generateIdentity("device-1", { extractable: true });
  localStorage.setItem("device-identity", JSON.stringify(await exportIdentity(identity)));
  return identity;
}
```

In produzione valutare storage più protetto e rotazione/revoca. La chiave privata nel browser è sempre esposta a XSS nell'origine.

## SSR

Il package è browser-oriented. In SSR:

- non chiamare `connect()` durante il rendering server;
- usare `autoConnect: false` e connettersi lato client;
- `document`/`window` non sono disponibili e il lifecycle è disattivato.

## Build di produzione verificata

La demo `examples/angular-nestjs/web` usa Angular 22.2.3 e viene compilata con:

```bash
pnpm --filter @p2plink/example-angular-web build
```

Output: `dist/browser`, servito da NestJS nella demo. Il test Playwright verifica connessione P2P, RPC, eventi, fallback e resume sulla build di produzione.

## Perché non NgModule

Il package è standalone-friendly e non richiede NgModule. `provideP2PLink` usa `makeEnvironmentProviders`; il service usa `inject` e Signals. Non c'è dipendenza da RxJS per l'uso ordinario.
