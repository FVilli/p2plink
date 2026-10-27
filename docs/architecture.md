# Architettura

## Obiettivi

- Una sola API applicativa: `request`, `on`, `getStatus`, `connect`, `disconnect`, `suspend`, `resume`.
- WebRTC DataChannel preferito, MQTT come signaling e fallback.
- Cambio trasporto trasparente, senza duplicare mutazioni.
- Sicurezza end-to-end sopra entrambi i trasporti.
- Framework-agnostic nel nucleo; Angular e NestJS sono adapter.
- Dipendenze native isolate nell'entry Node di `@p2plink/webrtc`.
- Funzionamento su un singolo piccolo server e un broker MQTT standard.

## Non obiettivi

Database distribuito, sincronizzazione documenti, identity provider, broker proprietario, piattaforma SaaS, framework di agenti, garanzia exactly-once.

## Grafo dei package

```mermaid
flowchart TD
  CORE[@p2plink/core]
  CRYPTO[@p2plink/crypto]
  MQTT[@p2plink/mqtt]
  RTC[@p2plink/webrtc]
  CLIENT[@p2plink/client]
  SERVER[@p2plink/server]
  ANGULAR[@p2plink/angular]
  NEST[@p2plink/nestjs]

  CRYPTO --> CORE
  MQTT --> CORE
  RTC --> CORE
  CLIENT --> CORE
  CLIENT --> CRYPTO
  CLIENT --> MQTT
  CLIENT --> RTC
  SERVER --> CORE
  SERVER --> CRYPTO
  SERVER --> MQTT
  SERVER --> RTC
  ANGULAR --> CLIENT
  ANGULAR --> CORE
  NEST --> SERVER
  NEST --> CORE
```

Il core non importa MQTT, WebRTC o Angular. `@p2plink/client` è la composition root dell'applicazione; `@p2plink/server` è la composition root lato servizio.

## Flusso di connessione

```mermaid
sequenceDiagram
  participant B as Browser client
  participant API as HTTPS bootstrap
  participant M as MQTT broker
  participant S as P2PLink server

  B->>API: POST /bootstrap + Bearer app token + identità pubblica
  API-->>B: capability monouso + credenziali MQTT + chiave server
  B->>M: CONNECT (credenziali a breve scadenza)
  B->>M: client-hello (capability, identità, chiave effimera, firma)
  M->>S: client-hello
  S->>S: verifica capability + firma + binding identità
  S->>M: server-hello (chiave effimera server, hash transcript, firma)
  M->>B: server-hello
  B->>B: verifica pin server + deriva chiavi
  S->>S: deriva le stesse chiavi
  B->>M: frame cifrato ping
  M->>S: frame cifrato ping
  S->>M: pong cifrato
  M->>B: pong cifrato
  Note over B,S: sessione MQTT pronta; RPC utilizzabile
  B->>M: signal offer (cifrato con chiavi MQTT)
  M->>S: signal offer
  S->>M: signal answer + ICE (cifrati)
  M->>B: answer + ICE
  B<->>S: DTLS DataChannel + heartbeat cifrati
  Note over B,S: WebRTC promosso dopo pong stabili
```

## Bootstrap

Il bootstrap è l'unico punto che vede il token applicativo. Deve essere HTTPS. Restituisce:

- `capability`: token firmato dal server, monouso, legato a `clientId`, fingerprint dell'identità, tenant/server, scadenza e nonce;
- `clientId` assegnato;
- credenziali MQTT (idealmente a breve scadenza);
- identità pubblica del server.

Il client verifica la chiave del server contro un pin opzionale e la usa per verificare il `server-hello`.

## Handshake di sessione

1. Il client genera una chiave ECDH P-256 effimera e un `sessionId` casuale.
2. Firma il `client-hello` con la chiave identità ECDSA P-256.
3. Il server verifica firma, capability, binding `clientId`/fingerprint, scadenza, nonce monouso e limiti.
4. Il server genera la propria chiave ECDH effimera e firma il `server-hello`, che include l'hash del client-hello.
5. Entrambi derivano il segreto ECDH e applicano HKDF-SHA-256 con salt = SHA-256 del transcript completo.
6. Vengono derivate quattro chiavi AES-256-GCM: `mqtt/c2s`, `mqtt/s2c`, `webrtc/c2s`, `webrtc/s2c`.
7. La sessione è considerata pronta solo dopo un ping/pong cifrato riuscito.

Dettagli: [protocol.md](protocol.md), [security.md](security.md).

## TransportManager

`@p2plink/core` contiene il cuore della selezione trasporto.

Responsabilità:

- sottoscrivere i due trasporti;
- cifrare/decifrare i frame con la chiave del trasporto corretto;
- inviare heartbeat su **entrambi** i trasporti aperti;
- misurare RTT per trasporto;
- promuovere WebRTC solo dopo stabilità e pong;
- retrocedere su MQTT in caso di chiusura o timeout;
- applicare un cooldown anti-flapping;
- esporre uno snapshot di stato.

Non conosce RPC né sessioni: riceve envelope e li instrada.

## Client

`P2PLinkClientImpl` orchestra:

1. identity provider;
2. bootstrap provider;
3. connessione MQTT;
4. endpoint di sessione;
5. handshake;
6. TransportManager;
7. RpcClient;
8. negoziazione WebRTC con backoff;
9. lifecycle browser;
10. reset sessione e riconnessione.

Gli eventi pubblici sono instradati dal client; le risposte RPC hanno correlation id.

## Server

`P2PLinkServer` mantiene:

- una connessione MQTT condivisa;
- una sottoscrizione wildcard `session/+/c2s`;
- una mappa `clientId → ServerSession`;
- un `RpcServer` condiviso con store di idempotenza;
- un engine WebRTC condiviso che crea un peer per sessione;
- un BootstrapService con store capability.

Ogni sessione ha il proprio TransportManager, trasporto MQTT, peer WebRTC, rate limiter, contatore richieste pendenti e identità verificata.

Le sessioni inattive vengono chiuse dopo `sessionIdleTimeoutMs`, misurato sull'ultimo trasporto sano o frame ricevuto.

## Threading e concorrenza

- JavaScript single-thread per processo.
- Le operazioni crittografiche sono asincrone WebCrypto.
- I frame in ingresso sono decifrati in serie per chiave, evitando race sulla replay window.
- Le mutazioni di stato del TransportManager sono sincrone sul microtask.
- Le code di invio WebRTC sono limitate e serializzate; il chunking non intreccia messaggi.

## Deployment minimo

```text
[Browser HTTPS/WSS] ── MQTT/WSS ──> [Mosquitto] <── MQTT/TLS ── [Node/NestJS + P2PLink]
        │                                                              │
        └──────────────── WebRTC DataChannel (se NAT permette) ────────┘
```

Componenti:

- un broker MQTT con TLS e ACL;
- un processo Node/NestJS che espone bootstrap HTTPS e mantiene la connessione MQTT;
- un frontend HTTPS che usa WSS.

Non servono porte in ingresso sui client. Senza STUN/TURN il P2P funziona solo quando esiste un percorso diretto (LAN, loopback, NAT favorevoli). Il fallback MQTT garantisce la raggiungibilità finché il broker è raggiungibile.

## Scelte di design rilevanti

- Signaling cifrato dentro la sessione MQTT invece di topic SDP in chiaro.
- Capability monouso invece del token applicativo su MQTT.
- Client sempre offerer: nessun glare.
- Nuova negoziazione WebRTC invece di ICE restart in-place; l'epoch impedisce signaling stantio.
- JSON come codec iniziale; nessun MessagePack/Protobuf senza misura.
- Errori tipizzati e `OUTCOME_UNKNOWN` per le mutazioni interrotte.
- Eventi best-effort, RPC con idempotenza esplicita.

Vedi [decisions.md](decisions.md).
