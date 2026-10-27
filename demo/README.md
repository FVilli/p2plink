# P2PLink Mesh Demo

Demo minimale che mostra P2PLink in una topologia **peer-to-peer a mesh**: ogni frontend e ogni processo NestJS è un peer. L'unico componente singolo è il broker MQTT.

```text
Browser A ── WebRTC/DataChannel ── Browser B
    \             (fallback MQTT)        /
     \                                  /
      ──────── MQTT broker ─────────────
     /                                  \
NestJS A ── WebRTC/DataChannel ─── NestJS B
```

Ogni peer:

- si annuncia sul broker;
- scopre gli altri peer;
- negozia un DataChannel WebRTC con ciascuno (il peer con `peerId` lessicograficamente minore è l'offerer);
- invia ping a rotazione a tutti i peer;
- riceve indietro gli stessi byte;
- misura se ogni ping è passato davvero su **P2P** o su **MQTT**;
- mostra byte e rate per peer.

Nessun server di signaling, discovery o coordinamento: solo MQTT.

## Requisiti

- Node.js >= 22
- pnpm 10
- Docker (broker demo)
- Chromium/Chrome per l'E2E

## Avvio

```bash
# 1. build dei package libreria dal root (una volta)
pnpm install
pnpm build

# 2. broker demo (porta 1884 TCP, 9002 WebSocket)
pnpm --dir demo broker:up

# 3. install/build del workspace demo autonomo
pnpm --dir demo install
pnpm --dir demo build

# 4. frontend (http://127.0.0.1:5174)
pnpm --dir demo dev:web

# 5. uno o più backend NestJS
MQTT_URL=mqtt://127.0.0.1:1884 \
MQTT_USERNAME=demo MQTT_PASSWORD=demo-pass \
PEER_NAME=nest-1 PORT=3100 PING_BYTES=2048 \
pnpm --dir demo dev:backend
```

Avviare un secondo backend in un altro terminale:

```bash
MQTT_URL=mqtt://127.0.0.1:1884 \
MQTT_USERNAME=demo MQTT_PASSWORD=demo-pass \
PEER_NAME=nest-2 PORT=3101 PING_BYTES=2048 \
pnpm --dir demo dev:backend
```

Aprire più schede del frontend: ogni scheda è un peer distinto. Il broker è l'unico servizio condiviso.

## Configurazione

### Frontend (Vite)

| Variabile            | Default               | Descrizione                    |
| -------------------- | --------------------- | ------------------------------ |
| `VITE_MQTT_URL`      | `ws://127.0.0.1:9002` | URL MQTT WebSocket             |
| `VITE_MQTT_USERNAME` | `demo`                | utente broker                  |
| `VITE_MQTT_PASSWORD` | `demo-pass`           | password broker                |
| `VITE_PING_BYTES`    | `2048`                | dimensione random payload ping |
| `VITE_PEER_NAME`     | `browser-<id>`        | nome visualizzato              |

### Backend NestJS

| Variabile        | Default                 | Descrizione                    |
| ---------------- | ----------------------- | ------------------------------ |
| `MQTT_URL`       | `mqtt://127.0.0.1:1884` | URL broker                     |
| `MQTT_USERNAME`  | `demo`                  | utente broker                  |
| `MQTT_PASSWORD`  | `demo-pass`             | password broker                |
| `PING_BYTES`     | `2048`                  | dimensione random payload ping |
| `PEER_NAME`      | `nest-<id>`             | nome visualizzato              |
| `PORT`           | `3100`                  | porta HTTP health/stats        |
| `WEBRTC_ENABLED` | `true`                  | `false` forza il solo MQTT     |

Le app non hanno un URL di server applicativo: conoscono solo broker e credenziali.

## Cosa mostra la tabella

- **route**: trasporto attivo corrente (`p2p`, `mqtt`, `connecting`); i byte sono attribuiti al trasporto effettivo del singolo ping, non dedotti dalla route;
- **rtt**: latenza dell'ultimo ping riuscito;
- **p2p bytes / mqtt bytes**: byte del payload dei ping scambiati su ciascun trasporto, in entrambe le direzioni;
- **p2p B/s / mqtt B/s**: rate su finestra mobile di 2 secondi;
- **pings / OK**: ping inviati e round-trip completati con hash valido; l'RTT è aggiornato solo sui round-trip validi.

I byte delle richieste e delle risposte sono contati sul peer che li invia e sul peer che li riceve. I heartbeat interni di P2PLink non sono conteggiati: la tabella misura il traffico applicativo della demo.

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

Il ricevente decodifica i byte, verifica lunghezza e SHA-256, poi restituisce **gli stessi byte e lo stesso hash**. Il mittente verifica la risposta. Un payload corrotto non viene restituito e produce un errore visibile.

Il trasporto effettivo è noto perché `TransportManager.send()` restituisce il trasporto usato e `onEnvelope` espone il trasporto su cui è arrivata la risposta: P2P e MQTT non vengono dedotti dal peer o dal topic.

## Toggle P2P

Il pulsante **P2P abilitato** chiude i DataChannel del peer locale e lascia attivo il fallback MQTT. I ping successivi passano dal broker e le colonne MQTT aumentano. Riattivandolo, il mesh rinegozia WebRTC con backoff.

Da terminale, il backend può essere avviato con `WEBRTC_ENABLED=false` per lo stesso effetto.

## Scalabilità orizzontale

- Ogni scheda browser è un peer indipendente.
- Ogni processo NestJS è un peer indipendente con il proprio `PEER_NAME` e `PORT`.
- Non c'è un server applicativo centrale né stato condiviso tra i backend.
- Il broker MQTT è l'unico elemento singolo.
- Per più host/repliche il broker deve avere TLS, ACL e credenziali a breve scadenza; questa demo usa credenziali locali.
- La mesh completa non è una promessa di scalabilità illimitata: connessioni e signaling crescono circa con il quadrato dei peer. La demo dimostra l'assenza di un coordinatore applicativo, non una capacità di carico misurata.
- Chi possiede le credenziali del broker demo può impersonare un peer: l'handshake TOFU non è il bootstrap autenticato della libreria.

## Autenticazione della demo

La demo usa un handshake TOFU (trust on first use) tra peer:

- ogni peer genera una chiave ECDSA P-256;
- l'identità pubblica è scambiata nel messaggio di presence MQTT;
- il peer offerente verifica la firma del server-hello contro la chiave pubblicata;
- il peer rispondente accetta l'identità del client al primo contatto.

Non è il modello di autenticazione di produzione di P2PLink (bootstrap HTTPS + capability monouso): è volutamente minimale. La demo mostra il trasporto, il routing e il fallback, non un sistema di identità utente.

## E2E

Con broker avviato e app compilate:

```bash
P2PLINK_CHROME_PATH=/usr/bin/google-chrome pnpm --dir demo e2e
```

Se Playwright ha Chromium installato, `P2PLINK_CHROME_PATH` può essere omesso.

Lo script avvia due backend, il preview Vite e due schede browser; verifica peer discovery, traffico P2P, fallback MQTT e ripristino P2P.

## Limiti

- Broker locale senza TLS/WSS.
- Credenziali demo statiche e condivise.
- Nessuno STUN/TURN: il P2P è verificato su loopback/LAN; fuori da percorsi diretti si usa MQTT.
- Identità TOFU, non autenticazione di produzione.
- Nessun event store, RPC applicativa o persistenza: la demo è solo trasporto + metriche.
