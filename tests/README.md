# Test layout

I test eseguibili sono collocati accanto al codice che coprono:

| Directory                        | Contenuto                                                   |
| -------------------------------- | ----------------------------------------------------------- |
| `packages/core/src/__tests__`    | protocollo, transport manager, RPC, idempotenza, rate limit |
| `packages/crypto/src/__tests__`  | handshake, frame, replay, pin                               |
| `packages/mqtt/src/__tests__`    | broker reale, ACL, endpoint                                 |
| `packages/webrtc/src/__tests__`  | DataChannel Node, chunking                                  |
| `packages/server/src/__tests__`  | integrazione client/server, sicurezza, capability           |
| `scripts/browser-demo-check.mjs` | E2E Chrome ↔ Node                                           |
| `scripts/angular-demo-check.mjs` | E2E Angular production ↔ NestJS                             |
| `scripts/benchmark.ts`           | benchmark 1/10/100 client                                   |

Questa directory documenta la mappatura e ospita eventuali test trasversali. Comandi e limiti: [docs/testing.md](../docs/testing.md).

## Aggiungere un test

- Unit: `*.test.ts` nella package interessata, con Vitest.
- Integrazione: usare il broker Mosquitto di `deployment/mosquitto`.
- E2E: preferire gli script Playwright esistenti e gli hook `server.dropP2P` / `client.suspend`.
- Non dichiarare testati browser o dispositivi non eseguiti.
