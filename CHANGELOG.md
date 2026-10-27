# Changelog

Tutte le modifiche rilevanti sono documentate qui. Il progetto segue un versionamento semantico durante lo sviluppo 0.x.

## 0.1.0 — 2026-10-26

Prima release funzionante del monorepo.

### Aggiunto

- `@p2plink/core`: envelope protocollo v1, codec JSON, errori tipizzati, TransportManager con heartbeat, promozione/fallback, RPC client/server, idempotenza in-memory, token bucket, topic builder.
- `@p2plink/crypto`: identità ECDSA P-256, handshake ECDH autenticato, HKDF-SHA-256, AES-256-GCM, replay window, capability firmate monouso.
- `@p2plink/mqtt`: connessione MQTT.js, endpoint client/server, QoS 1, ACL-ready topic, session-reset.
- `@p2plink/webrtc`: engine browser, node-datachannel e werift, DataChannel, signaling cifrato, chunking, backpressure, negoziazione con epoch.
- `@p2plink/client`: API applicativa tipizzata, bootstrap HTTPS, fallback, recovery, suspend/resume, lifecycle browser.
- `@p2plink/server`: sessioni multi-client, bootstrap, capability store, RPC handler, WebRTC answerer, graceful shutdown, debug drop P2P.
- `@p2plink/angular`: provider standalone, Signals, service con cleanup.
- `@p2plink/nestjs`: dynamic module, `@P2PHandler`, discovery, bootstrap controller.
- Demo `browser-node` e `angular-nestjs`, build di produzione Angular.
- Test unit/integration/sicurezza, PoC browser, benchmark 1/10/100 client.
- Documentazione tecnica e configurazione Mosquitto.

### Limitazioni note

- Handshake non ancora sottoposto ad audit crittografico indipendente.
- Firefox/WebKit reali e WebView Telegram non testati in questo ambiente.
- Nessun test automatico di packet loss/riordino a livello rete.
- TURN non richiesto; STUN esplicito.
- Multi-replica server richiede store condivisi e un owner per sessione.
- Pubblicazione npm non eseguita.
