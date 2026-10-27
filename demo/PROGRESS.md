# P2PLink Mesh Demo — Progress

Aggiornato dal coordinatore. Gli agenti non modificano questo file.

| id  | stato | task                                                                       | agente                  |
| --- | ----- | -------------------------------------------------------------------------- | ----------------------- |
| D1  | ✅    | Scaffold demo, workspace autonomo e broker Mosquitto locale                | lead                    |
| D2  | ✅    | Motore mesh condiviso: presence, pair, handshake TOFU, ping/hash, metriche | lead                    |
| D3  | ✅    | Backend NestJS peer con console stats e /stats                             | worker-backend          |
| D4  | ✅    | Frontend Vite peer con tabella, rate e toggle P2P                          | worker-web              |
| D5  | ✅    | E2E: 2 NestJS + 2 browser, P2P, fallback, ripristino, integrità            | lead                    |
| D6  | ✅    | README demo e istruzioni di scalabilità orizzontale                        | lead                    |
| D7  | ✅    | Review indipendente finale e fix                                           | oracle/evidence-auditor |
| D8  | ✅    | Validazione browser↔browser e Nest↔Nest in P2P                             | lead                    |
| D9  | ✅    | Build finale, pulizia e verifica root                                      | lead                    |
| D10 | ✅    | Broker remoto mqtt.fvsg.it + onboarding url/username/password/client name  | lead                    |
| D11 | ✅    | Configurazione Firebase Hosting (progetto p2plink-demo)                    | lead                    |
| D12 | ✅    | Immagine Docker node:24-alpine + compose con password da env               | lead                    |
| D13 | ✅    | Pubblicazione GHCR via GitHub Actions                                      | lead                    |
| D14 | ✅    | Deploy Firebase Hosting → https://p2plink-demo.web.app                     | lead                    |
| D15 | ✅    | E2E onboarding + persistenza localStorage                                  | lead                    |
| D16 | ✅    | Immagine GHCR pubblica e pull verificato                                   | GitHub Actions          |
| D17 | ✅    | Presence per-peer e riduzione probe MQTT idle                              | lead                    |

Legenda: ⏳ queued · 🏃 in corso · 🔍 review/test · ✅ fatto · ❌ bloccato
