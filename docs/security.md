# Sicurezza

P2PLink può trasportare dati privati. La sicurezza è nel protocollo, non un'aggiunta finale. Questo documento descrive cosa è implementato, quali minacce copre e cosa **non** promette.

> **Stato di revisione:** le primitive sono WebCrypto standard, ma la costruzione dell'handshake e il formato capability sono specifici di P2PLink e non hanno ancora avuto un audit crittografico indipendente. Per dati ad alto rischio, richiedere una revisione prima della produzione.

## Modello di fiducia

- Il **bootstrap HTTPS** e l'autenticazione applicativa sono la radice di fiducia per l'identità del client.
- La **chiave pubblica del server** è ottenuta dal bootstrap su TLS e può essere ulteriormente pinnata dall'app.
- Il **broker MQTT è considerato non fidato** per riservatezza e integrità dei payload; resta necessario per disponibilità e ACL.
- Il client è considerato potenzialmente compromesso se l'applicazione è compromessa (XSS): nessuna libreria può proteggere da JavaScript malevolo nella stessa origine.
- Il server applicativo è fidato per autorizzazione e dati.

## Bootstrap

Il token applicativo (JWT, sessione, Telegram `initData`, credenziale dispositivo, …) viene inviato **solo** all'endpoint HTTPS di bootstrap. Non viene mai scritto su MQTT.

Il client invia:

```json
{
  "protocolVersion": 1,
  "clientId": "requested-id",
  "tenant": "default",
  "serverId": "server-1",
  "identityId": "device-1",
  "identityPublicKey": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." },
  "requestId": "uuid"
}
```

Il server:

1. autentica il token tramite `BootstrapAuthenticator`;
2. verifica il JWK pubblico;
3. calcola il fingerprint SHA-256 della chiave;
4. emette una **capability monouso** firmata con la chiave identità del server;
5. restituisce credenziali MQTT ottenute da `mqttCredentials` (l'app decide come emetterle);
6. restituisce la propria chiave pubblica.

La capability contiene: `sub`, `clientId`, `tenant`, `serverId`, fingerprint identità, nonce, `iat`, `exp`, claim applicativi opzionali. È codificata come JWS compatto `header.payload.signature` con ECDSA P-256/SHA-256 (alg `ES256`).

Il server consuma il nonce **alla prima verifica dell'handshake**, non all'emissione. Un replay della capability viene rifiutato con `CAPABILITY_USED`. Il default store è in memoria; per più repliche serve uno store condiviso (Redis/DB).

La scadenza predefinita è 60 secondi. Il client deve usare la capability subito.

## Identità

- **Client:** chiave ECDSA P-256. Può essere generata dalla libreria o fornita dall'app (persistita). La chiave privata può essere non estraibile (`extractable: false`); in tal caso l'app deve conservarla tramite un provider.
- **Server:** chiave ECDSA P-256 persistita dall'app. La chiave pubblica è distribuita tramite bootstrap TLS e può essere pinnata.
- **Fingerprint:** SHA-256 del JWK pubblico normalizzato (`kty`, `crv`, `x`, `y`), base64url, prefisso `sha256:`.

La capability lega `clientId` e fingerprint. Il server verifica la firma del client-hello **con la chiave pubblica vincolata dalla capability**, non con una chiave dichiarata arbitrariamente.

## Handshake

```text
client-hello:
  tenant, serverId, clientId, sessionId, identityId,
  identityPublicKey, ephemeralPublicKey, nonce, capability, issuedAt, signature

server-hello:
  stessi identificatori, identityPublicKey, ephemeralPublicKey,
  hash(client-hello firmato), nonce, issuedAt, signature
```

- Firme ECDSA P-256/SHA-256 con domain separation esplicita.
- JSON canonico con chiavi ordinate.
- Scadenza/clock skew default 120 s.
- Il client verifica l'hash del proprio hello e la firma del server.
- Il server verifica firma, capability, binding, tenant/server, scadenza, nonce e limiti.

### Perché non un semplice token su MQTT

TLS protegge il token **verso il broker**, non **dal broker**. Un broker compromesso potrebbe leggerlo e riusarlo. Con la capability:

- il token applicativo resta su HTTPS;
- la capability è monouso e a breve scadenza;
- la capability è inutile senza la chiave privata del client, perché il client-hello è firmato;
- anche un replay completo del client-hello non permette al broker di derivare la chiave ECDH effimera.

## Derivazione chiavi

```text
shared     = ECDH(P-256 effimera)
transcript = canonicalJson({clientHello, serverHello})
salt       = SHA-256("p2plink/v1/transcript\n" || transcript)
```

HKDF-SHA-256 produce quattro chiavi AES-256-GCM:

```text
p2plink/v1/mqtt/{sessionId}/c2s
p2plink/v1/mqtt/{sessionId}/s2c
p2plink/v1/webrtc/{sessionId}/c2s
p2plink/v1/webrtc/{sessionId}/s2c
```

Separare le chiavi per trasporto impedisce il riuso di nonce tra MQTT e DataChannel. Separare le direzioni impedisce riflessioni.

## Protezione dei frame

```text
0x02 | versione 1 | counter u64 | IV 12 byte | ciphertext+tag
IV = prefisso casuale 4 byte || counter u64
AAD = "p2plink/v1|{transport}|{sessionId}|{counter}"
```

- AES-256-GCM, tag 128 bit.
- Contatore monotono, mai riutilizzato.
- Replay window 1024, commit solo dopo autenticazione.
- Prefisso IV verificato costante per chiave.
- Limite dimensione prima di allocare/decifrare.
- `KEY_EXHAUSTED` a 2^48 frame: la sessione va rinegoziata.
- Le chiavi non vengono mai ruotate in-place: una nuova sessione usa nuove chiavi effimere.

## Signaling e DataChannel

- SDP/ICE viaggiano cifrati e autenticati con le chiavi MQTT: il broker non può alterarli.
- Il DataChannel è considerato utilizzabile solo dopo ping/pong cifrati con la chiave WebRTC. Questo prova che entrambi i lati condividono la stessa sessione.
- `negotiationId` ed `epoch` impediscono signaling stantio.
- `session-reset` è firmato dal server e verificato dal client; un broker può ritardarlo, perderlo o replicarne uno valido entro la finestra di freschezza, causando un reconnect/DoS ma non impersonificazione.

## Broker

La cifratura end-to-end **non sostituisce** l'autorizzazione del broker:

- usare TLS/WSS in produzione;
- autenticazione obbligatoria, niente anonymous;
- ACL least-privilege per client e server;
- credenziali MQTT a breve scadenza quando possibile;
- limiti di pacchetto e connessione;
- isolamento tenant/server nei topic.

Con ACL statiche `%u`, il broker non lega crittograficamente username e client ID. Il server rifiuta comunque un clientId diverso da quello firmato, ma un client malevolo con credenziali legittime potrebbe tentare di leggere topic di un altro client. I payload sono cifrati; i metadati restano visibili. Per un isolamento forte usare EMQX JWT/HTTP o Mosquitto Dynamic Security/go-auth.

## Threat model

| Minaccia                       | Mitigazione                                                                | Test                                             |
| ------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------ |
| Peer impersonation             | Firma ECDSA + capability bound a fingerprint                               | `crypto.test.ts`, `security.integration.test.ts` |
| Signaling injection            | Signaling cifrato, epoch, negotiationId                                    | test integrazione + browser E2E                  |
| Replay applicativo             | Frame counter + replay window; capability nonce monouso                    | `crypto.test.ts`, `security.integration.test.ts` |
| Cross-tenant                   | Topic tenant/server + ACL + claim capability                               | ACL test, topic validation                       |
| Sottoscrizione non autorizzata | ACL broker, `%u`                                                           | `mqtt.integration.test.ts`                       |
| Message flooding               | Rate limit per sessione, max pending, dimensione massima                   | limiti configurabili; test payload               |
| Handshake exhaustion           | Limite handshake simultanei, rate per client, max sessioni, timeout        | implementato; test parziale                      |
| Oversized payload              | Limite client e server prima di allocare/decifrare                         | test oversize                                    |
| Session hijacking              | Chiavi per sessione, nonce/counter, capability legata all'identità         | test crittografici                               |
| Reconnection abuse             | Capability monouso, sessioni sostituite, rate limit                        | replay test                                      |
| Malicious broker               | E2E AES-GCM, signaling cifrato, pin server, capability                     | test tamper/replay                               |
| Credenziali client rubate      | Token solo HTTPS; capability breve e monouso; MQTT ACL                     | limiti, bootstrap auth                           |
| XSS                            | Non completamente mitigabile dalla libreria; chiavi non estraibili aiutano | fuori scope                                      |

## Cosa non è coperto

- **Autorizzazione applicativa:** P2PLink autentica la sessione e trasporta un'identità verificata. Le regole su quali dati può leggere un utente sono dell'applicazione (`P2PRequestContext`/`authorize`).
- **Exactly-once:** vedi [reliability.md](reliability.md).
- **Disponibilità contro un broker malevolo:** un broker può sempre negare il servizio e osservare i metadati.
- **Analisi del traffico:** dimensioni e timing dei messaggi restano visibili al broker e agli osservatori di rete.
- **Compromissione del dispositivo:** un client compromesso può abusare della propria identità finché il token è valido.
- **Audit crittografico indipendente:** non ancora eseguito.
- **Forward secrecy a lungo termine:** le chiavi di sessione sono effimere; la chiave identità a lungo termine non è ruotata automaticamente. La compromissione futura della chiave identità non decifra sessioni passate (grazie a ECDH effimero), ma consente impersonificazione futura se il token la autorizza.

## Limiti implementati

Vedi [protocol.md](protocol.md) e `DEFAULT_LIMITS`. In sintesi: 64 KiB payload, 256 KiB frame, 64 pending RPC, 500 sessioni, 50 handshake simultanei, 1024 replay window, 120 s idle sessione.

## Segnalazione vulnerabilità

Vedi [SECURITY.md](../SECURITY.md). Non aprire issue pubbliche per vulnerabilità non risolte.
