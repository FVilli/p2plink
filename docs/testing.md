# Test

## Prerequisiti

- Node.js >= 22 (testato 24.19).
- pnpm 10.
- Docker per Mosquitto.
- Chrome di sistema per i test browser in questo ambiente.

```bash
pnpm install
pnpm build
pnpm broker:up
pnpm test
```

Il broker deve essere raggiungibile su `mqtt://127.0.0.1:1883` e `ws://127.0.0.1:9001`, oppure impostare `P2PLINK_BROKER_URL`.

## Unit test

| Area                 | File                                           | Copertura                                                          |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| Envelope/codec/topic | `packages/core/src/__tests__/protocol.test.ts` | round-trip, oversize, tipi sconosciuti, signaling, topic injection |
| TransportManager     | `transport-manager.test.ts`                    | promozione WebRTC, fallback, offline, frame estranei/alterati      |
| RPC                  | `rpc.test.ts`                                  | request/response, errori, timeout, deduplica, retry idempotente    |
| Idempotenza          | `idempotency.test.ts`                          | claim/complete/release, scadenza                                   |
| Rate limit           | `rate-limit.test.ts`                           | token bucket                                                       |
| Crittografia         | `crypto.test.ts`                               | handshake, derivazione, pin, tamper, replay, riordino              |
| Capability           | `capability.test.ts`                           | firma, tamper, scadenza, target errato, nonce monouso              |
| Chunking             | `chunking.test.ts`                             | split/reassembly, fuori ordine, oversize, timeout                  |
| WebRTC               | `webrtc-transport.test.ts`                     | DataChannel Node↔Node, frame 100 KB                                |

```bash
pnpm test
```

I test in `@p2plink/mqtt` e `@p2plink/server` richiedono il broker reale.

## Integration test

### MQTT

`packages/mqtt/src/__tests__/mqtt.integration.test.ts`:

- connessione autenticata al broker reale;
- handshake e frame binari bidirezionali;
- ACL: un client non riceve i messaggi del namespace di un altro client;
- re-subscribe dopo riconnessione (comportamento MQTT.js + wrapper).

### Server ↔ client

`packages/server/src/__tests__/server.integration.test.ts`:

- bootstrap e capability;
- handshake cifrato;
- RPC tipizzata;
- eventi push;
- idempotenza con due chiamate identiche;
- P2P reale con `node-datachannel`;
- drop P2P lato server → fallback MQTT → RPC → ripristino P2P.

### Sicurezza

`packages/server/src/__tests__/security.integration.test.ts`:

- bootstrap con token errato → 401;
- replay della capability → connessione rifiutata;
- capability alterata → connessione rifiutata;
- reset di sessione firmato/verificato e reset forgiato ignorato;
- handshake concorrenti per lo stesso client serializzati;
- payload oltre il limite → `PAYLOAD_TOO_LARGE` prima della trasmissione.

## Browser end-to-end

### Browser ↔ Node

Servizi:

```bash
pnpm broker:up
pnpm --filter @p2plink/example-browser-node dev:server
pnpm --filter @p2plink/example-browser-node dev:web
node scripts/browser-demo-check.mjs
```

Verifica con Chrome headless:

1. connessione P2P;
2. RPC su P2P;
3. guasto P2P simulato;
4. fallback MQTT;
5. ripristino P2P;
6. suspend → offline;
7. resume → nuova sessione P2P.

### Angular ↔ NestJS

```bash
pnpm broker:up
pnpm --filter @p2plink/example-angular-web build
pnpm --filter @p2plink/example-nest-server build
pnpm --filter @p2plink/example-nest-server start
node scripts/angular-demo-check.mjs
```

Verifica la **build di produzione Angular 22** servita da NestJS 12: P2P, RPC tipizzata, evento push, fallback, ripristino, suspend/resume.

Gli script usano Chrome di sistema se `P2PLINK_CHROME_PATH` è impostato; altrimenti usano Chromium installato da Playwright (`pnpm exec playwright install chromium`).

## Limiti dell'ambiente di test

- Playwright 1.64 non installa Chromium su Ubuntu 26.04; è stato usato Chrome di sistema. Non è stato possibile eseguire Firefox e WebKit reali in questo ambiente.
- Non sono state testate WebView Telegram su Android/iOS reali. Non vengono dichiarate testate.
- I test browser usano loopback e `iceServers: []`. Non coprono NAT simmetrico, CGNAT, STUN/TURN reali, perdita di pacchetti o cambio rete mobile.
- Non esiste un test automatico di packet loss/duplicazione/riordino a livello di rete. Riordino e replay sono coperti a livello crittografico; il chunking è testato fuori ordine.
- Il broker di test è Mosquitto locale. Non sono testati EMQX, cluster, failover broker o ACL dinamiche.

## Fault injection disponibile

- `server.dropP2P(clientId)` chiude solo il trasporto WebRTC di una sessione; usato dalla demo e dal test di fallback.
- `client.suspend()` chiude tutti i trasporti e simula una sospensione di rete/app.
- `token bucket`, limiti payload e timeout sono configurabili nei test.
- Frame alterati, replay e riordino sono generati nei test crittografici.
- Broker non disponibile: fermare il container e osservare `offline`/riconnessione; non è automatizzato in CI.

## Test manuale WebView Telegram

Procedura suggerita (da eseguire su dispositivi reali prima di dichiarare il supporto):

1. Pubblicare la demo su HTTPS con WSS e certificato valido.
2. Aprire la Mini App in Telegram Android e iOS.
3. Verificare `status = p2p` o `mqtt`; se `mqtt`, verificare che il fallback funzioni.
4. Background dell'app per 30 s, ritorno: verificare probe e stato.
5. Cambio Wi-Fi → mobile: verificare fallback e recovery.
6. Blocco/sblocco schermo.
7. Chiusura Mini App e riapertura.
8. `suspend`/`resume` dalla UI.
9. Controllare che il token bootstrap non compaia nei log MQTT.
10. Verificare che il broker veda solo connessioni WSS e topic autorizzati.

Ripetere su almeno un Android e un iOS reali. Fino ad allora, il supporto WebView Telegram non è dichiarato testato.

## CI

`.github/workflows/ci.yml` esegue:

- install con pnpm;
- build di tutti i package;
- typecheck;
- lint;
- test unit/integration con Mosquitto come service/step Docker;
- build delle demo;
- test browser con Playwright/Chrome quando i browser sono disponibili.

I test browser possono essere sensibili all'ambiente grafico; in CI usare Chromium headless con `--no-sandbox`.

## Comandi utili

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm --filter @p2plink/core test
pnpm --filter @p2plink/server test
docker compose -f deployment/mosquitto/docker-compose.yml logs -f
```
