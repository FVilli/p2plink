# Security tests

I test di sicurezza eseguibili sono:

- `packages/crypto/src/__tests__/crypto.test.ts`: tamper, replay, pin server, cross-transport.
- `packages/server/src/__tests__/capability.test.ts`: firma, scadenza, target, nonce monouso.
- `packages/server/src/__tests__/security.integration.test.ts`: token errato, replay capability, capability alterata, payload oversize.
- `packages/mqtt/src/__tests__/mqtt.integration.test.ts`: isolamento ACL su broker reale.

Non sono coperti automaticamente: packet loss, flooding distribuito, broker compromesso attivo, WebView reali. Vedi [docs/security.md](../../docs/security.md).
