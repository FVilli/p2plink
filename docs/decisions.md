# Decisioni architetturali

## ADR-001 — `node-datachannel` come motore Node predefinito

**Stato:** accettata.

**Contesto:** servono RTCDataChannel e interoperabilità browser su Node LTS, con deploy semplice su Linux x64/arm64.

**Decisione:** usare `node-datachannel` (libdatachannel) come default; `werift` come alternativa pura TypeScript.

**Motivi:** prebuild, API W3C polyfill, interoperabilità verificata con Chrome, nessuna compilazione nativa su questa macchina.

**Conseguenze:** dipendenza MPL-2.0 isolata nell'entry Node di `@p2plink/webrtc`; il browser non la include. Chi non può usare binari nativi passa a `werift` o a un engine custom.

## ADR-002 — Signaling cifrato dentro la sessione MQTT

**Stato:** accettata.

**Contesto:** lo schema classico usa topic MQTT separati per SDP/ICE. Un broker compromesso potrebbe riscrivere SDP e dirottare il WebRTC.

**Decisione:** dopo l'handshake, offer/answer/ICE sono envelope `signal` cifrati con le chiavi `mqtt/*` e pubblicati sui topic di sessione. Il topic `signal/*/s2c` resta solo per `session-reset` in chiaro, senza segreti.

**Conseguenze:** il broker non può alterare il signaling; si perde la possibilità di ispezionare SDP dal broker. I topic di signaling non contengono SDP retained.

## ADR-003 — Bootstrap HTTPS con capability monouso

**Stato:** accettata.

**Contesto:** inviare il token applicativo su MQTT lo espone al broker. Un semplice server ID dichiarato non autentica nessuno.

**Decisione:** il token applicativo viaggia solo su HTTPS. Il bootstrap restituisce una capability firmata, monouso, legata a clientId + fingerprint della chiave identità + tenant/server + scadenza, oltre alle credenziali MQTT.

**Conseguenze:** serve un endpoint HTTPS di bootstrap o un'integrazione equivalente. Il server deve condividere/chiave identità e store nonce tra repliche.

## ADR-004 — AKE custom con primitive standard

**Stato:** accettata con revisione pendente.

**Contesto:** non esiste una libreria AKE browser/Node matura che copra esattamente capability, pin server e transport binding senza dipendenze pesanti.

**Decisione:** ECDSA P-256 + ECDH effimero P-256 + HKDF-SHA-256 + AES-256-GCM, con transcript canonico, domain separation e conferma bidirezionale tramite heartbeat.

**Conseguenze:** la costruzione non è "crittografia artigianale" nel senso di primitive inventate, ma è comunque un protocollo specifico. Non dichiarare sicurezza production-grade senza audit indipendente.

## ADR-005 — JSON come codec iniziale

**Stato:** accettata.

**Contesto:** MessagePack/Protobuf aggiungono dipendenze e tooling; i payload sono piccoli.

**Decisione:** JSON UTF-8 con validazione runtime e limite di dimensione. Interfaccia `Codec` sostituibile.

**Conseguenze:** overhead e parsing più lenti rispetto a un formato binario, ma semplicità e debug migliori. Un codec binario richiede una misura reale prima di essere introdotto.

## ADR-006 — Nessuna dipendenza da RxDB o simple-peer

**Stato:** accettata.

**Contesto:** RxDB è una libreria di replica documenti; simple-peer è inattivo.

**Decisione:** studiare i pattern di signaling/heartbeat, non adottare le dipendenze.

**Conseguenze:** meno peso, meno licenze, più controllo. Il costo è implementare il lifecycle P2P.

## ADR-007 — Il client è sempre l'offerer

**Stato:** accettata.

**Contesto:** due peer che si offrono contemporaneamente producono glare.

**Decisione:** solo il client crea l'offerta; il server è sempre answerer. Ogni negoziazione ha un `epoch` e un `negotiationId`.

**Conseguenze:** niente glare; il server non può avviare un P2P senza una richiesta del client. ICE restart in-place non è implementato: si crea un nuovo peer.

## ADR-008 — Chiavi separate per trasporto e direzione

**Stato:** accettata.

**Contesto:** riusare la stessa chiave e lo stesso contatore su MQTT e DataChannel causerebbe riuso di nonce AES-GCM.

**Decisione:** quattro chiavi derivate con info HKDF distinte: `mqtt/c2s`, `mqtt/s2c`, `webrtc/c2s`, `webrtc/s2c`.

**Conseguenze:** nessun riuso di nonce tra trasporti; il costo è quattro chiavi e quattro replay window.

## ADR-009 — Retry solo per richieste idempotenti

**Stato:** accettata.

**Contesto:** un failover può lasciare l'esito di una mutazione sconosciuto.

**Decisione:** il client ritrasmette automaticamente solo richieste con `idempotent: true`; le altre restano pending fino al timeout e poi falliscono con `OUTCOME_UNKNOWN`. Il server deduplica per identità + request id/idempotency key.

**Conseguenze:** niente doppie mutazioni silenziose; l'applicazione deve gestire esplicitamente l'incertezza. Exactly-once richiede transazioni applicative.

## ADR-010 — Eventi best-effort

**Stato:** accettata.

**Contesto:** promettere consegna persistente richiederebbe un event store e un protocollo di ack/ripresa.

**Decisione:** gli eventi push non hanno ACK, retry o persistenza. La risincronizzazione è applicativa.

**Conseguenze:** semplicità e nessun falso exactly-once; i dati critici vanno letti via RPC.

## ADR-011 — Composition root separate

**Stato:** accettata.

**Contesto:** il core deve restare indipendente da MQTT/WebRTC; il browser non deve includere dipendenze native.

**Decisione:** il core espone interfacce; `@p2plink/client` e `@p2plink/server` compongono i trasporti; `@p2plink/webrtc` ha entry `.` (browser) e `/node`.

**Conseguenze:** più package, ma confini chiari e bundle browser pulito. Angular importa `@p2plink/client`; NestJS importa `@p2plink/server`.

## ADR-012 — Nessuno STUN pubblico implicito

**Stato:** accettata.

**Contesto:** dipendere da STUN pubblici non controllati è imprudente e non riproducibile.

**Decisione:** `iceServers` è esplicito; default `[]`. TURN è supportato tramite configurazione ma non richiesto.

**Conseguenze:** su Internet senza STUN il P2P può non partire e si usa MQTT; l'operatore deve configurare STUN/TURN.

## ADR-013 — Engine WebRTC risolto per entry point

**Stato:** accettata.

**Contesto:** importare `node-datachannel` nel bundle browser rompe la build.

**Decisione:** `@p2plink/client` usa l'engine browser; `@p2plink/client/node` usa `createNodeWebRtcEngine()`. Il server importa esplicitamente `@p2plink/webrtc/node`.

**Conseguenze:** nessuna dipendenza nativa nel browser. L'utente deve scegliere l'entry corretta.

## ADR-014 — Angular con ng-packagr, NestJS dual build

**Stato:** accettata.

**Contesto:** Angular richiede APF/partial-Ivy; NestJS 12 è ESM ma molti consumer usano CJS.

**Decisione:** `@p2plink/angular` è compilato con ng-packagr 22; `@p2plink/nestjs` è ESM+CJS via tsup, con `@Inject` espliciti per non dipendere da `emitDecoratorMetadata` del consumer.

**Conseguenze:** build più lenta per Angular; interoperabilità NestJS più ampia.

## ADR-015 — Benchmark con server in processo separato

**Stato:** accettata.

**Contesto:** server e 100 client nello stesso processo Node esaurivano risorse di peer/socket, producendo un limite artificiale.

**Decisione:** il benchmark avvia il server con `scripts/bench-server.ts` in un processo separato e i client nel processo principale; il bootstrap avviene via HTTP locale.

**Conseguenze:** misura più realistica; 100/100 client raggiungono il P2P. I numeri restano indicativi, non una garanzia.
