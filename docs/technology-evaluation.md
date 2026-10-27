# Valutazione tecnologica

Data della verifica: **26 ottobre 2026**. Versioni lette dal registry npm, dai repository e dalla documentazione ufficiale. Le versioni cambiano: i numeri sotto sono quelli effettivamente usati nei test del repository.

## Criteri

1. Supporto reale di RTCDataChannel e interoperabilità con browser.
2. Funzionamento su Node.js LTS senza dipendenze fragili.
3. Manutenzione attiva e licenza compatibile con un progetto MIT.
4. Compatibilità browser/bundler per il client.
5. Costo operativo su un piccolo server Linux.
6. Possibilità di isolare le dipendenze native in un package dedicato.

## Matrice

| Tecnologia              |     Versione verificata | Licenza                   | Node/Web                                                          | Esito                        |
| ----------------------- | ----------------------: | ------------------------- | ----------------------------------------------------------------- | ---------------------------- |
| `node-datachannel`      |                  0.33.5 | **MPL-2.0**               | Node, binding libdatachannel, prebuild Linux x64/arm64 glibc/musl | **Motore Node predefinito**  |
| `werift`                |                  0.25.2 | MIT                       | Node >= 22, TypeScript puro                                       | **Motore Node alternativo**  |
| `simple-peer`           |                  9.11.1 | MIT                       | Browser-oriented, CJS, `wrtc` opzionale                           | **Scartato**                 |
| `mqtt` (MQTT.js)        |                  5.16.1 | MIT                       | Browser WSS + Node, MQTT 5                                        | **Adottato**                 |
| RxDB WebRTC replication |                    17.x | Apache-2.0                | Browser/Node con simple-peer                                      | **Studiato, non dipendenza** |
| Eclipse Mosquitto       | 2.1.2 (immagine Docker) | EPL-2.0 / EDL             | Broker leggero, WebSocket, ACL                                    | **Broker di test e demo**    |
| EMQX                    |                 5.x/6.x | BSL 1.1 dalle release 5.9 | Broker scalabile, JWT/HTTP auth                                   | **Alternativa documentata**  |
| Angular                 |                  22.2.3 | MIT                       | Browser                                                           | Integrazione                 |
| NestJS                  |                  12.2.0 | MIT                       | Node ESM                                                          | Integrazione                 |

## WebRTC lato Node.js

### node-datachannel

**Vantaggi**

- Binding a libdatachannel con binari precompilati per Linux x64/arm64 (glibc e musl), macOS, Windows e Android arm64.
- Polyfill W3C (`node-datachannel/polyfill`) con `RTCPeerConnection`, `RTCDataChannel`, `addIceCandidate`, eventi standard.
- Interoperabilità browser verificata nella PoC: Chrome ↔ Node, offerta browser, answer Node, `ping-p2p`/`pong-p2p`.
- Nessuna compilazione nativa richiesta nei test su questa macchina.

**Svantaggi**

- Licenza **MPL-2.0**: è compatibile con un progetto MIT come dipendenza, ma i file MPL restano MPL e le modifiche a quei file devono essere rese disponibili. P2PLink non copia codice.
- Dipendenza nativa: va isolata nel package WebRTC e nell'entry Node; non deve entrare nel bundle browser.
- Binari opzionali per piattaforma: in ambienti esotici serve una build.

**Decisione:** motore Node predefinito.

### werift

**Vantaggi**

- Implementazione WebRTC completa in TypeScript puro: nessun addon nativo.
- Supporto RTCDataChannel, ICE, DTLS, SCTP; `engines.node >= 22`.
- Interoperabilità browser verificata nella PoC con la stessa sequenza offer/answer/DataChannel.
- Licenza MIT.

**Svantaggi**

- API non identica a W3C (`Event.subscribe`, `ch.send`, `stateChanged`); richiede un adapter.
- Ecosistema e numero di deploy inferiore rispetto a libdatachannel.
- Alcuni dettagli SDP/ICE possono divergere dai browser.

**Decisione:** motore alternativo supportato tramite `createWeriftEngine()`; non è il default.

### simple-peer

**Perché è stato scartato**

- Ultimo rilascio npm: 9.11.1 del **2022-02-17**; manutenzione inattiva.
- Pensato per il browser e per un polyfill `wrtc`; il supporto Node moderno non è garantito.
- ICE restart non mergiato (PR aperta da anni).
- Aggiungerebbe un layer CJS con `get-browser-rtc` e dipendenze non necessarie, senza vantaggi rispetto a un adapter diretto.

La PoC non lo ha usato. RxDB lo usa, ma RxDB non è una dipendenza di P2PLink.

### RxDB WebRTC replication

Documentazione studiata: `getConnectionHandlerSimplePeer()`, signaling, peer lifecycle, heartbeat, riconnessione con backoff 500 ms → 15 s, timeout di connessione 15 s, `createSimplePeerWrtc()` per Node.

Elementi adottati concettualmente:

- signaling come canale separato dal trasporto dati;
- heartbeat applicativo e timeout;
- backoff esponenziale con jitter;
- connessioni esistenti mantenute mentre il signaling è offline.

Elementi non adottati:

- simple-peer;
- signaling WebSocket dedicato;
- modello di replica documenti;
- signaling non autenticato.

Licenza RxDB Apache-2.0: nessun codice copiato.

## MQTT

MQTT.js 5.16.1 è usato in browser e Node.

- Supporto MQTT 5 e MQTT 3.1.1.
- WebSocket in browser, TCP/TLS in Node.
- QoS 0/1/2; P2PLink usa QoS 1 per signaling e frame.
- Sessioni `clean: true`; riconnessione automatica e re-subscribe.
- Payload binari (`Uint8Array`/Buffer).
- Last Will non usato per il protocollo applicativo: la liveness è verificata da heartbeat cifrati, non dallo stato del broker.

QoS 1 è **at-least-once**, non exactly-once. La deduplicazione RPC è applicativa (request id / idempotency key).

## Broker

### Mosquitto

- Immagine `eclipse-mosquitto:2`, versione 2.1.2 nei test.
- TCP 1883 + WebSocket 9001.
- `password_file`, `acl_file`, pattern ACL con `%u`/`%c`.
- `max_packet_size` e `message_size_limit` configurabili.
- Leggero e adatto a un mini PC.

**Limite:** le credenziali statiche non legano crittograficamente username e client ID. La demo usa un utente per client e ACL `%u`; per credenziali realmente a breve scadenza servono Dynamic Security, un plugin di auth o EMQX JWT/HTTP.

### EMQX

- Supporto nativo JWT e HTTP auth/authorization, ACL claim e disconnessione alla scadenza del token.
- Più adatto a installazioni grandi o multi-tenant.
- Licenza BSL 1.1 dalle release 5.9: verificare i termini prima dell'uso commerciale.

**Decisione:** P2PLink resta broker-agnostico; Mosquitto è il default di test/demo, EMQX è documentato come alternativa.

## Angular e NestJS

- Angular 22.2.3: provider standalone, `EnvironmentProviders`, Signals, `DestroyRef`; build libreria con ng-packagr 22.2.5 e TypeScript 6.
- NestJS 12.2.0: dynamic module, `DiscoveryService`, `MetadataScanner`, `Reflector`, shutdown hooks; pacchetto ESM.
- NestJS 12 è ESM; `@p2plink/nestjs` è prodotto in ESM+CJS per interoperabilità, ma i test di integrazione sono su NestJS 12 ESM.

## Licenze

| Componente       | Licenza             | Compatibilità                                                 |
| ---------------- | ------------------- | ------------------------------------------------------------- |
| P2PLink          | MIT                 | —                                                             |
| node-datachannel | MPL-2.0             | Sì come dipendenza separata; obblighi MPL sui file modificati |
| werift           | MIT                 | Sì                                                            |
| MQTT.js          | MIT                 | Sì                                                            |
| Angular/NestJS   | MIT                 | Sì                                                            |
| Mosquitto        | EPL-2.0/EDL         | Solo tool di test/demo, non linkato                           |
| EMQX             | BSL 1.1 (dalla 5.9) | Da valutare per uso commerciale                               |

Nessun codice sorgente di terze parti è stato copiato in P2PLink.

## Fonti

- RxDB WebRTC replication: https://rxdb.info/replication-webrtc.html
- RxDB simple-peer handler: https://github.com/pubkey/rxdb/blob/master/src/plugins/replication-webrtc/connection-handler-simple-peer.ts
- simple-peer: https://github.com/feross/simple-peer
- simple-peer npm: https://www.npmjs.com/package/simple-peer
- werift: https://github.com/shinyoshiaki/werift-webrtc
- node-datachannel: https://github.com/murat-dogan/node-datachannel
- MQTT.js: https://github.com/mqttjs/MQTT.js
- Mosquitto ACL: https://mosquitto.org/documentation/plugins/acl-file/
- Mosquitto configuration: https://mosquitto.org/man/mosquitto-conf-5.html
- Mosquitto Dynamic Security: https://mosquitto.org/documentation/dynamic-security/
- EMQX JWT: https://docs.emqx.com/en/emqx/latest/access-control/authn/jwt.html
- EMQX HTTP authorization: https://docs.emqx.com/en/emqx/latest/access-control/authz/http.html
- Angular libraries: https://angular.dev/tools/libraries/creating-libraries
- Angular EnvironmentProviders: https://angular.dev/api/core/EnvironmentProviders
- NestJS dynamic modules: https://docs.nestjs.com/fundamentals/dynamic-modules
- NestJS discovery: https://docs.nestjs.com/fundamentals/discovery-service
- NestJS lifecycle: https://docs.nestjs.com/fundamentals/lifecycle-events

## Riproduzione della PoC

La PoC storica è stata eseguita in `/tmp` con Mosquitto 2.1.2, Chrome headless, MQTT.js e entrambi i motori Node. I test versionati che la sostituiscono sono:

- `packages/webrtc/src/__tests__/webrtc-transport.test.ts` — DataChannel e chunking;
- `packages/server/src/__tests__/server.integration.test.ts` — browser-equivalent Node ↔ server, signaling MQTT cifrato, fallback e recovery;
- `scripts/browser-demo-check.mjs` — Chrome reale ↔ Node con la demo `examples/browser-node`;
- `scripts/angular-demo-check.mjs` — Angular 22 production build ↔ NestJS 12 con Chrome reale.
