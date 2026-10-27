# End-to-end

Gli script E2E vivono in `scripts/` per essere richiamati anche dalla CI e dalla documentazione.

- `scripts/browser-demo-check.mjs`: avvia Chrome, verifica P2P, RPC, fallback, ripristino, suspend/resume sulla demo browser-node.
- `scripts/angular-demo-check.mjs`: verifica la build di produzione Angular servita da NestJS.

Prerequisiti e comandi: [docs/testing.md](../../docs/testing.md).
