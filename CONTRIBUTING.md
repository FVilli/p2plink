# Contributing

Grazie per voler contribuire a P2PLink.

## Setup

```bash
pnpm install
pnpm broker:up
pnpm build
pnpm test
```

Requisiti: Node.js >= 22, pnpm 10, Docker (solo per broker/test).

## Flusso

1. Aprire una issue per cambiamenti non banali.
2. Creare un branch dedicato.
3. Mantenere i confini dei package: il core non importa MQTT/WebRTC/Angular.
4. Aggiungere test per comportamento nuovo o corretto.
5. Eseguire `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check`.
6. Aggiornare la documentazione e `CHANGELOG.md` quando cambia il comportamento pubblico.

## Stile

- TypeScript strict, ESM, nessun `any` non giustificato.
- Preferire API piccole e difficili da usare in modo insicuro.
- Non introdurre dipendenze senza una motivazione e una verifica di licenza.
- Non copiare codice da progetti con licenze incompatibili.
- Non inserire segreti, credenziali reali o dati personali.
- Non promettere exactly-once, sicurezza non verificata o disponibilità non testata.

## Test

- Unit: `pnpm --filter @p2plink/core test`, `@p2plink/crypto`, `@p2plink/webrtc`.
- Integrazione: richiede Mosquitto (`pnpm broker:up`).
- Browser: seguire [docs/testing.md](docs/testing.md).
- Se un test non può essere eseguito nell'ambiente, dichiararlo nella PR.

## Sicurezza

Non aprire issue pubbliche per vulnerabilità. Seguire [SECURITY.md](SECURITY.md).

## Licenza

Contribuendo accetti che il contributo sia distribuito con licenza MIT. I file di terze parti mantengono la propria licenza.
