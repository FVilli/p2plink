# P2PLink Mesh Demo

Demo minimale che mostra P2PLink in una topologia **peer-to-peer a mesh**: ogni browser e ogni processo NestJS è un peer. L'unico componente singolo è il broker MQTT.

```text
Browser A ── WebRTC DataChannel ── Browser B
    \          fallback MQTT          /
     ─────────── Mosquitto ───────────
    /                                  \
NestJS A ── WebRTC DataChannel ── NestJS B
```

Ogni peer:

- si annuncia sul broker;
- scopre gli altri peer;
- negozia un DataChannel WebRTC con ciascuno (il `peerId` lessicograficamente minore è l'offerer);
- invia ping a rotazione a tutti i peer;
- riceve indietro gli stessi byte;
- verifica lunghezza e SHA-256 ad ogni round-trip;
- attribuisce i byte al trasporto **effettivamente** usato (P2P o MQTT);
- mostra byte, numero di messaggi e rate per peer;
- separa i contatori per direzione (`tx`/`rx`) e per trasporto.

Nessun server di signaling, discovery o coordinamento: solo MQTT.

### Topic

```text
p2plink-demo/v2/presence/{peerId}
p2plink-demo/v2/signal/{to}/{from}
p2plink-demo/v2/data/{to}/{from}
p2plink-demo/v2/issues/{peerId}
```

- `presence` è per-peer: ogni peer pubblica solo il proprio stato e tutti si sottoscrivono a `presence/+`. Il `peerId` nel topic deve coincidere con quello nel payload.
- `signal` contiene `to` e `from`: trasporta handshake, offer/answer/ICE cifrati con chiavi di signaling dedicate.
- `data` trasporta **solo** i frame applicativi che non sono passati su P2P (fallback MQTT). Quando tutte le coppie sono P2P non viene pubblicato nulla su `data`.
- `presence` viene pubblicata ogni 30 secondi per peer, con retain per permettere a un nuovo peer di scoprire subito la rete; Last Will pulisce la presence in caso di disconnessione anomala. Include i contatori **soggettivi** del peer: messaggi/byte trasmessi e ricevuti, separati per P2P e MQTT.
- `issues` trasporta problemi e diagnostica (`error`/`warn`) con peer, versione, user-agent/platform e contesto; non contiene password. I client si sottoscrivono a `issues/+` e li mostrano nella UI e nei log del backend.

Il namespace è passato a `v2` per isolare le vecchie schede che pubblicavano presence ogni 2 secondi.

## UI

- lo stato in alto mostra solo `🟢 MQTT` / `🔴 MQTT` / `⚪ MQTT`;
- `Self peer` mostra nome/ID a sinistra e, a destra, le icone `⚙️` impostazioni e `↺` reset;
- il reset chiede conferma prima di azzerare i contatori;
- il riepilogo mostra `Peers` senza due punti, con il numero in grassetto sotto, poi `Outbound` e `Inbound` con P2P e MQTT;
- i problemi recenti scompaiono automaticamente dopo 60 secondi;
- l'app demo usa la versione `0.2.1`.

## Tre frontend identici

La stessa UI è disponibile in tre implementazioni, tutte con lo stesso onboarding, PWA, tabelle, contatori formattati e diagnostica MQTT:

| Variante                  | Sorgente           | URL                                  |
| ------------------------- | ------------------ | ------------------------------------ |
| Vanilla TypeScript + Vite | `demo/web`         | https://p2plink-demo.web.app         |
| Angular 22                | `demo/angular-web` | https://p2plink-demo-angular.web.app |
| React 19 + Vite           | `demo/react-web`   | https://p2plink-demo-react.web.app   |

Build e deploy:

```bash
pnpm --dir demo install
pnpm --dir demo build

pnpm --dir demo deploy:web
pnpm --dir demo deploy:angular
pnpm --dir demo deploy:react
```

Le tre app usano la stessa configurazione `p2plink-demo-config` nel `localStorage`, ma ogni origine è un peer MQTT distinto. Ogni app è una PWA installabile e funziona offline dalla cache del proprio service worker.

- Angular usa la pipe standalone `p2pByteSize` di `@p2plink/angular`;
- React usa un componente locale che chiama `formatByteSize` da `@p2plink/core`;
- la demo vanilla usa la stessa `formatByteSize`.

## PWA e offline

La web app è una PWA installabile:

- manifest e icone incluse;
- service worker generato con `vite-plugin-pwa`;
- app shell disponibile offline;
- banner “Sei offline” quando `navigator.onLine` è falso;
- versione applicativa visibile nell'header e nella colonna compatta `Peer` della tabella;
- la versione è inclusa anche nei messaggi presence e nella tabella console NestJS.

Quando si torna online, la web app ritenta automaticamente la connessione se esiste una configurazione salvata.

## Raspberry Pi / ARM

L'immagine GHCR è multi-arch:

- `linux/amd64` per PC/server x86;
- `linux/arm64` per Raspberry Pi 3/4/5 con sistema operativo a **64 bit** (Raspberry Pi OS 64-bit, Ubuntu arm64, DietPi arm64). Verificare con `uname -m` → `aarch64`.

Non è supportato il Raspberry Pi OS a 32 bit (`armv7`/`armhf`), perché la base `node:24-alpine` non fornisce quel runtime. Su un Pi 4/5 usare l'OS a 64 bit.

```bash
docker pull ghcr.io/fvilli/p2plink-demo:latest
docker image inspect ghcr.io/fvilli/p2plink-demo:latest \
  --format '{{.Os}}/{{.Architecture}}'
```

Docker sceglie automaticamente l'architettura corretta. La build arm64 usa il binario precompilato `node-datachannel` per `linux-arm64-musl`.

## Broker predefinito

| Voce                     | Valore                                                         |
| ------------------------ | -------------------------------------------------------------- |
| MQTT TLS (Node)          | `mqtts://mqtt.fvsg.it:8883`                                    |
| MQTT WebSocket (browser) | `wss://mqtt-ws.fvsg.it:443/ws`                                 |
| Username                 | `main:rmq-usr`                                                 |
| Password                 | inserita dall'utente nella web app (salvata in `localStorage`) |
| Namespace topic          | `p2plink-demo/#`                                               |

La password **non è nel repository**. Per il backend Docker viene passata tramite `MQTT_PASSWORD` nel compose/env.

## Requisiti

- Node.js >= 22
- pnpm 10
- Docker per l'immagine backend o per il broker locale di test
- Chromium/Chrome per l'E2E

## Avvio con il broker remoto

```bash
# 1. build dei package libreria dal root
pnpm install
pnpm build

# 2. install/build del workspace demo autonomo
pnpm --dir demo install
pnpm --dir demo build

# 3. frontend
pnpm --dir demo dev:web
# http://127.0.0.1:5174
```

Al primo caricamento la web app mostra un onboarding con:

- **Broker WebSocket URL** (precompilato con `wss://mqtt-ws.fvsg.it:443/ws`)
- **Username** (precompilato con `main:rmq-usr`)
- **Password** (obbligatoria, non precompilata)
- **Client name**

Tutti i valori vengono salvati in `localStorage` come oggetto `p2plink-demo-config`. Il pulsante **Impostazioni** permette di modificarli.

### Backend NestJS

```bash
MQTT_PASSWORD='<password>' \
PEER_NAME=nest-1 PORT=3100 PING_BYTES=2048 \
pnpm --dir demo dev:backend
```

`MQTT_URL` e `MQTT_USERNAME` hanno già come default il broker e lo username remoti. La password è obbligatoria.

Un secondo processo:

```bash
MQTT_PASSWORD='<password>' \
PEER_NAME=nest-2 PORT=3101 PING_BYTES=2048 \
pnpm --dir demo dev:backend
```

Aprire più schede del frontend: ogni scheda è un peer distinto. Il broker è l'unico servizio condiviso.

## Broker locale (test/E2E/offline)

```bash
pnpm --dir demo broker:up
# 1884 TCP, 9002 WebSocket, utente demo / demo-pass
```

Override:

```bash
MQTT_URL=mqtt://127.0.0.1:1884 \
MQTT_USERNAME=demo MQTT_PASSWORD=demo-pass \
PEER_NAME=nest-local PORT=3100 \
pnpm --dir demo dev:backend
```

Nel browser compilare l'onboarding con `ws://127.0.0.1:9002`, `demo`, `demo-pass`.

## Configurazione

### Frontend

| Variabile            | Default                        | Descrizione                     |
| -------------------- | ------------------------------ | ------------------------------- |
| `VITE_MQTT_URL`      | `wss://mqtt-ws.fvsg.it:443/ws` | URL MQTT WebSocket              |
| `VITE_MQTT_USERNAME` | `main:rmq-usr`                 | username broker                 |
| `VITE_PING_BYTES`    | `2048`                         | dimensione random payload ping  |
| `VITE_STUN_URLS`     | `stun:stun.l.google.com:19302` | STUN demo, separati da virgola  |
| `VITE_PEER_NAME`     | `browser-<id>`                 | nome di default nell'onboarding |

La password viene gestita dall'onboarding, non da una variabile di build.

### Backend NestJS

| Variabile              | Default                        | Descrizione                                            |
| ---------------------- | ------------------------------ | ------------------------------------------------------ |
| `MQTT_URL`             | `mqtts://mqtt.fvsg.it:8883`    | URL broker                                             |
| `MQTT_USERNAME`        | `main:rmq-usr`                 | username broker                                        |
| `MQTT_PASSWORD`        | —                              | password broker, obbligatoria                          |
| `APP_VERSION`          | `0.2.1`                        | versione mostrata nella presence/console               |
| `PING_BYTES`           | `2048`                         | dimensione random payload ping                         |
| `PRESENCE_INTERVAL_MS` | `30000`                        | intervallo presence; minimo 1000 ms                    |
| `STUN_URLS`            | `stun:stun.l.google.com:19302` | STUN demo, separati da virgola; vuoto per disabilitare |
| `PEER_NAME`            | `nest-<id>`                    | nome visualizzato                                      |
| `PORT`                 | `3100`                         | porta HTTP health/stats                                |
| `WEBRTC_ENABLED`       | `true`                         | `false` forza il solo MQTT                             |

Le app non hanno un URL di server applicativo: conoscono solo broker e credenziali.

## Tabella

- **Peer**: icona browser `🌐` o servizio `🖥️`, nome in grassetto e versione in piccolo/grigio;
- **route**: trasporto attivo corrente (`p2p`, `mqtt`, `connecting`); i byte sono attribuiti al trasporto effettivo del singolo ping, non dedotti dalla route;
- **rtt**: latenza dell'ultimo ping riuscito;
- **p2p bytes / mqtt bytes**: byte del payload dei ping scambiati su ciascun trasporto, in entrambe le direzioni; sono formattati automaticamente in `B`, `KB` o `MB` con una cifra decimale;
- **p2p msgs / mqtt msgs**: numero di messaggi applicativi scambiati su ciascun trasporto; il tooltip mostra `tx`/`rx` locali e i contatori riportati dal peer nella presence;
- **p2p B/s / mqtt B/s**: rate su finestra mobile di 2 secondi, formattati con la stessa unità automatica;
- **pings / OK**: ping inviati e round-trip completati con hash valido;
- **Version**: versione dichiarata dal peer nella presence;
- **route/status**: emoji `🟢 p2p`, `🟡 mqtt`, `⏳ connecting`, `🟢/🔴 MQTT` per rendere immediata la lettura della sezione connected.

I byte e i messaggi delle richieste e delle risposte sono contati sul peer che li invia e sul peer che li riceve. I heartbeat interni di P2PLink non sono conteggiati.

## Diagnostica problemi via MQTT

Ogni peer pubblica problemi applicativi su `p2plink-demo/v2/issues/{peerId}` (QoS 1, non retain). Per seguirli:

```bash
mosquitto_sub -h mqtt.fvsg.it -p 8883 --cafile ... \
  -u 'main:rmq-usr' -P "$MQTT_PASSWORD" \
  -t 'p2plink-demo/v2/issues/+' -v
```

La UI mostra gli ultimi problemi ricevuti e il backend NestJS li stampa nei log. Il contesto include user-agent, piattaforma, stato online/secure-context e fase dell'errore, per diagnosticare client Android.

Se il client non riesce proprio a connettersi al broker, l'issue viene tentata su una connessione diagnostica separata; se anche questa fallisce non c'è un canale MQTT disponibile e resta l'errore mostrato nella UI.

## Integrità e routing

Ogni ping contiene:

```json
{
  "kind": "ping",
  "id": "...",
  "size": 2048,
  "bytes": "<base64url random>",
  "hash": "<SHA-256 base64url>"
}
```

Il ricevente verifica lunghezza e SHA-256, poi restituisce gli stessi byte e hash. Il mittente verifica la risposta. Un payload corrotto non viene restituito.

Il trasporto effettivo è noto perché `TransportManager.send()` restituisce il trasporto usato e `onEnvelope` espone il trasporto su cui è arrivata la risposta.

Il fallback MQTT viene reso disponibile **appena la sessione MQTT è aperta e l'handshake è completato**, senza aspettare il primo ping/pong. Il P2P può richiedere qualche secondo in più; la route MQTT è immediatamente utilizzabile.

## Forzare il fallback MQTT

Il toggle P2P è stato rimosso dalla UI. Per una prova di fallback si può avviare un backend con `WEBRTC_ENABLED=false`, oppure usare l'hook di test della suite E2E. I ping successivi passano dal broker e le colonne MQTT aumentano.

## Docker / GHCR

Immagine backend basata su `node:24-alpine`, pubblicata su GHCR:

```bash
docker pull ghcr.io/fvilli/p2plink-demo:latest
docker build -f demo/backend/Dockerfile -t p2plink-demo .   # build locale
```

Il workflow `.github/workflows/demo-image.yml` pubblica:

```text
ghcr.io/fvilli/p2plink-demo:latest
ghcr.io/fvilli/p2plink-demo:sha-<commit>
```

Avvio con il compose:

```bash
cp demo/.env.example demo/.env
# inserire MQTT_PASSWORD in demo/.env
docker compose -f demo/docker-compose.yml --env-file demo/.env up -d
# health: http://127.0.0.1:3100/health
```

Il compose usa `MQTT_USERNAME=main:rmq-usr` e il broker remoto. Per Docker su un piccolo server, esporre solo le porte necessarie e non rendere pubblico il file `.env`.

## Firebase Hosting

Configurazione inclusa:

- `.firebaserc` → progetto `p2plink-demo`
- `firebase.json` → hosting da `web/dist`
- script `deploy:web`

```bash
npx --yes firebase-tools@latest login
pnpm --dir demo deploy:web
```

Deploy eseguito: **https://p2plink-demo.web.app**

In CI il workflow `.github/workflows/demo-hosting.yml` richiede il secret `FIREBASE_TOKEN` (`firebase login:ci`) per i deploy automatici successivi.

## E2E

Con broker locale avviato e app compilate:

```bash
P2PLINK_CHROME_PATH=/usr/bin/google-chrome pnpm --dir demo e2e
```

Lo script usa override runtime per il broker locale, avvia due backend e due schede, e verifica:

- discovery di tutti i peer;
- round-trip di ogni coppia;
- P2P browser↔browser e Nest↔Nest;
- fallback MQTT;
- ripristino P2P;
- payload alterato rifiutato.

## Scalabilità orizzontale

- Ogni scheda browser è un peer indipendente.
- Ogni processo NestJS è un peer indipendente con il proprio `PEER_NAME` e `PORT`.
- Non c'è un server applicativo centrale né stato condiviso tra i backend.
- Il broker MQTT è l'unico elemento singolo.
- La mesh completa non è una promessa di scalabilità illimitata: connessioni e signaling crescono circa con il quadrato dei peer. La demo dimostra l'assenza di un coordinatore applicativo, non una capacità di carico misurata.
- Chi possiede le credenziali del broker demo può impersonare un peer: l'handshake TOFU non è il bootstrap autenticato della libreria.

## Autenticazione della demo

La demo usa un handshake TOFU (trust on first use) tra peer:

- ogni peer genera una chiave ECDSA P-256;
- l'identità pubblica è scambiata nel messaggio di presence MQTT;
- il peer offerente verifica la firma del server-hello contro la chiave pubblicata;
- il peer rispondente accetta l'identità del client al primo contatto.

Non è il modello di autenticazione di produzione di P2PLink (bootstrap HTTPS + capability monouso): è volutamente minimale.

## Limiti

- La password è memorizzata in `localStorage`: XSS nell'origine può leggerla.
- Broker remoto con TLS/WSS, ma credenziali demo condivise e STUN pubblico.
- Nessun TURN: il P2P può fallire dietro NAT restrittivi; in quel caso si usa MQTT.
- Identità TOFU, non autenticazione di produzione.
- Nessun event store, RPC applicativa o persistenza: la demo è solo trasporto + metriche.
