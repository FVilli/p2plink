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
- mostra byte e rate per peer.

Nessun server di signaling, discovery o coordinamento: solo MQTT.

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

| Variabile        | Default                        | Descrizione                                            |
| ---------------- | ------------------------------ | ------------------------------------------------------ |
| `MQTT_URL`       | `mqtts://mqtt.fvsg.it:8883`    | URL broker                                             |
| `MQTT_USERNAME`  | `main:rmq-usr`                 | username broker                                        |
| `MQTT_PASSWORD`  | —                              | password broker, obbligatoria                          |
| `PING_BYTES`     | `2048`                         | dimensione random payload ping                         |
| `STUN_URLS`      | `stun:stun.l.google.com:19302` | STUN demo, separati da virgola; vuoto per disabilitare |
| `PEER_NAME`      | `nest-<id>`                    | nome visualizzato                                      |
| `PORT`           | `3100`                         | porta HTTP health/stats                                |
| `WEBRTC_ENABLED` | `true`                         | `false` forza il solo MQTT                             |

Le app non hanno un URL di server applicativo: conoscono solo broker e credenziali.

## Tabella

- **route**: trasporto attivo corrente (`p2p`, `mqtt`, `connecting`); i byte sono attribuiti al trasporto effettivo del singolo ping, non dedotti dalla route;
- **rtt**: latenza dell'ultimo ping riuscito;
- **p2p bytes / mqtt bytes**: byte del payload dei ping scambiati su ciascun trasporto, in entrambe le direzioni;
- **p2p B/s / mqtt B/s**: rate su finestra mobile di 2 secondi;
- **pings / OK**: ping inviati e round-trip completati con hash valido.

I byte delle richieste e delle risposte sono contati sul peer che li invia e sul peer che li riceve. I heartbeat interni di P2PLink non sono conteggiati.

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

## Toggle P2P

Il pulsante **P2P abilitato** chiude i DataChannel del peer locale e lascia attivo il fallback MQTT. I ping successivi passano dal broker e le colonne MQTT aumentano. Riattivandolo, il mesh rinegozia WebRTC con backoff.

Da terminale, il backend può essere avviato con `WEBRTC_ENABLED=false` per lo stesso effetto.

## Docker / GHCR

Immagine backend basata su `node:24-alpine`:

```bash
docker build -f demo/backend/Dockerfile -t p2plink-demo .
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

L'URL atteso è `https://p2plink-demo.web.app`.

In CI il workflow `.github/workflows/demo-hosting.yml` richiede il secret `FIREBASE_TOKEN` (`firebase login:ci`). Non è stato possibile completare il deploy da questo ambiente senza autenticazione Firebase.

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
