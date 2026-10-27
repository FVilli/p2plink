# Protocollo applicativo

Versione corrente: **1**. Il numero è presente in ogni envelope e nei messaggi di handshake. Un peer che riceve una versione non supportata chiude la sessione con un errore tipizzato.

## Livelli

```text
┌──────────────────────────────────────────────┐
│ Bootstrap HTTPS (token applicativo)           │
├──────────────────────────────────────────────┤
│ Handshake di sessione (JSON, firmato)         │
├──────────────────────────────────────────────┤
│ Envelope applicativo (JSON)                   │
├──────────────────────────────────────────────┤
│ Frame cifrato AES-256-GCM (binario)           │
├──────────────────────────────────────────────┤
│ MQTT QoS 1            │ WebRTC DataChannel    │
└──────────────────────────────────────────────┘
```

## Envelope

```ts
interface Envelope {
  v: 1;
  id: string; // UUID/ID univoco del messaggio
  sid: string; // session id
  type: "request" | "response" | "error" | "event" | "ping" | "pong" | "close" | "signal";
  ts: number; // epoch ms
  cid?: string; // correlation id (risposta/errore/pong)
  idem?: string; // chiave di idempotenza opzionale per request
  payload: unknown;
}
```

Regole:

- `v` deve essere `1`.
- `id`: 1–128 caratteri.
- `sid`: 8–128 caratteri; nella pratica 32+.
- `ts` è informativo, non usato per l'ordinamento.
- `cid` collega una risposta alla richiesta.
- `idem` è una chiave stabile scelta dal client; il server la combina con l'identità autenticata.
- Il payload deve essere presente (può essere `null`).
- JSON codificato in UTF-8; dimensione massima configurabile.

## Richiesta

```json
{
  "v": 1,
  "id": "8f4b...",
  "sid": "session...",
  "type": "request",
  "ts": 1793058000000,
  "idem": "add-item-42",
  "payload": {
    "method": "users.get",
    "params": { "id": "42" }
  }
}
```

`method` è una stringa 1–128 con caratteri `[A-Za-z0-9_.:-]`. `params` è il payload del contratto tipizzato; per un metodo `void` il client invia `null`.

## Risposta

```json
{
  "v": 1,
  "id": "b1c2...",
  "sid": "session...",
  "type": "response",
  "ts": 1793058000100,
  "cid": "8f4b...",
  "payload": { "id": "42", "name": "Ada" }
}
```

## Errore

```json
{
  "v": 1,
  "id": "c3d4...",
  "sid": "session...",
  "type": "error",
  "ts": 1793058000200,
  "cid": "8f4b...",
  "payload": {
    "code": "FORBIDDEN",
    "message": "Not allowed",
    "retryable": false,
    "outcomeUnknown": false
  }
}
```

Codici principali: `OFFLINE`, `TIMEOUT`, `PROTOCOL`, `AUTH_FAILED`, `FORBIDDEN`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `OUTCOME_UNKNOWN`, `TRANSPORT_UNAVAILABLE`, `TRANSPORT_SEND_FAILED`, `HANDLER_ERROR`, `METHOD_NOT_FOUND`, `SESSION_CLOSED`, `SESSION_RESET`, `IDEMPOTENCY_IN_PROGRESS`, `REPLAY_DETECTED`, `DECRYPT_FAILED`, `KEY_EXHAUSTED`, `CAPABILITY_INVALID`, `CAPABILITY_USED`, `UNSUPPORTED_VERSION`, `INVALID_CONFIG`, `CLOSED`, `ABORTED`.

## Evento push

```json
{
  "v": 1,
  "id": "e1...",
  "sid": "session...",
  "type": "event",
  "ts": 1793058000300,
  "payload": {
    "event": "appointment.updated",
    "data": { "id": "a-1" }
  }
}
```

Gli eventi sono best-effort. Non hanno ACK, non vengono ritentati e possono perdersi durante una disconnessione. Non esiste un event store distribuito.

## Ping/pong

Envelope `ping` con `payload: null`. Il ricevente risponde con `pong` e `cid = ping.id`. I ping sono consumati dal TransportManager e non raggiungono il livello RPC.

## Session reset

Il controllo `session-reset` sul topic `signal/{clientId}/s2c` non è un envelope applicativo. Contiene `v`, `kind`, `clientId`, `sessionId?`, `reason`, `issuedAt` e una `signature` ECDSA P-256 del server sul payload canonico. Il client lo accetta solo se la firma, il clientId, la sessione (quando presente) e la freschezza sono validi.

## Chiusura

```json
{ "reason": "client-disconnect", "code": "NORMAL" }
```

Il server chiude la sessione. Una sessione inattiva viene chiusa anche dal GC server.

## Signaling

Il signaling non usa un envelope separato: è un envelope `signal` cifrato con le chiavi MQTT. Il payload è:

```ts
type SignalPayload =
  | { kind: "offer"; negotiationId: string; epoch: number; sdp: { type: "offer"; sdp: string } }
  | { kind: "answer"; negotiationId: string; epoch: number; sdp: { type: "answer"; sdp: string } }
  | { kind: "ice"; negotiationId: string; epoch: number; candidate: IceCandidateInit }
  | { kind: "bye"; negotiationId: string; epoch: number; reason?: string };
```

Regole:

- `epoch` è un intero non negativo; cresce a ogni nuova negoziazione.
- Un transport ignora signaling con `negotiationId`/`epoch` diversi.
- Il client è sempre l'offerer.
- ICE può arrivare prima della remote description: viene accodato (massimo 128 candidati) e applicato dopo.
- Il signaling non usa messaggi retained.

## Handshake

I messaggi di handshake sono JSON preceduti dal byte `0x01` sul topic di sessione MQTT.

### client-hello

```ts
interface ClientHello {
  v: 1;
  kind: "client-hello";
  tenant: string;
  serverId: string;
  clientId: string;
  sessionId: string;
  identityId: string;
  identityPublicKey: JsonWebKey; // ECDSA P-256
  ephemeralPublicKey: JsonWebKey; // ECDH P-256
  nonce: string; // base64url, >= 16 byte
  capability: string; // capability monouso dal bootstrap
  issuedAt: number;
  signature: string; // base64url, ECDSA SHA-256
}
```

La firma copre:

```text
"p2plink/v1/handshake/client-hello\n" || canonicalJson(hello senza signature)
```

`canonicalJson` ordina le chiavi degli oggetti e rifiuta valori non finiti/undefined.

### server-hello

```ts
interface ServerHello {
  v: 1;
  kind: "server-hello";
  tenant: string;
  serverId: string;
  clientId: string;
  sessionId: string;
  identityId: string;
  identityPublicKey: JsonWebKey; // ECDSA P-256 del server
  ephemeralPublicKey: JsonWebKey; // ECDH P-256 del server
  clientHelloHash: string; // SHA-256 base64url del client-hello firmato
  nonce: string;
  issuedAt: number;
  signature: string;
}
```

La firma copre `"p2plink/v1/handshake/server-hello\n" || canonicalJson(hello senza signature)`.

### Transcript e chiavi

```text
transcript = canonicalJson({ clientHello, serverHello })
salt       = SHA-256("p2plink/v1/transcript\n" || transcript)
shared     = ECDH(ephemeral privata locale, effimera pubblica remota)
```

HKDF-SHA-256 con `salt` e info:

```text
p2plink/v1/mqtt/{sessionId}/c2s
p2plink/v1/mqtt/{sessionId}/s2c
p2plink/v1/webrtc/{sessionId}/c2s
p2plink/v1/webrtc/{sessionId}/s2c
```

Ogni chiave è una chiave AES-256-GCM. `c2s` significa client → server.

## Frame cifrato

Formato binario:

```text
byte 0      : 0x02 (magic)
byte 1      : 0x01 (versione frame)
byte 2..9   : contatore 64-bit big-endian
byte 10..21 : IV 12 byte = prefisso casuale 4 byte || contatore 8 byte
byte 22..   : ciphertext AES-256-GCM + tag 16 byte
```

AAD:

```text
"p2plink/v1|{transport}|{sessionId}|{counter}"
```

- Il prefisso IV è casuale per chiave e deve restare costante per tutti i frame ricevuti con quella chiave.
- Il contatore non viene mai riutilizzato sotto la stessa chiave.
- Il ricevente verifica magic, versione, dimensione, prefisso, replay window e tag prima di accettare il frame.
- La replay window è di 1024 posizioni; i frame fuori ordine dentro la finestra sono accettati una sola volta.
- Il contatore viene marcato come visto solo dopo autenticazione riuscita.
- Esaurimento del contatore: `KEY_EXHAUSTED`; la sessione va rinegoziata.

## Trasporto DataChannel

Sopra il frame cifrato, il DataChannel aggiunge un framing per chunking:

```text
0x10 || frame                       // messaggio singolo
0x11 || msgId u32 || index u16 || count u16 || chunk   // frammento
```

- Chunk size predefinito: 12.000 byte.
- Massimo 65.535 chunk.
- Frame massimo predefinito: 256 KiB.
- Riassemblaggio con timeout 10 s, massimo 32 messaggi in volo.
- `bufferedAmount` controllato prima di ogni invio; coda limitata (default 8 MiB).
- Un frame troppo grande fallisce con `PAYLOAD_TOO_LARGE`; non viene mai allocata una coda illimitata.

MQTT non applica chunking: il frame cifrato è il payload MQTT. I limiti sono imposti da `maxFrameBytes`, da `maxPayloadBytes` applicativo e dal broker (`message_size_limit`, `max_packet_size`).

## Versionamento

- `v` è obbligatorio.
- Nuovi `type` sconosciuti vengono ignorati con log, non causano crash.
- Nuovi campi opzionali possono essere aggiunti senza cambiare `v`; i parser ignorano campi sconosciuti.
- Un cambiamento incompatibile di handshake/frame richiede una nuova versione e un nuovo namespace di topic.
- Il codec è sostituibile dietro `Codec`; oggi è JSON.

## Limiti di protocollo

| Limite                        | Default |
| ----------------------------- | ------: |
| Payload applicativo           |  64 KiB |
| Frame cifrato                 | 256 KiB |
| Messaggio handshake           |  32 KiB |
| Capability                    |  16 KiB |
| SDP                           | 128 KiB |
| ICE candidate                 |   8 KiB |
| Richieste pendenti per client |      64 |
| Sessioni server               |     500 |
| Handshake simultanei          |      50 |
| Pending ping                  |       8 |
| Replay window                 |    1024 |

Tutti configurabili tramite `limits`, entro valori ragionevoli.

## Compatibilità evolutiva

- Il server rifiuta versioni non supportate.
- Il client rifiuta un `server-hello` con hash/tenant/server/session diversi.
- Messaggi malformati vengono scartati senza esporre dettagli sensibili.
- Gli errori del server non includono stack trace o messaggi interni non controllati.
