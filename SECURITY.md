# Security Policy

## Versioni supportate

P2PLink è in fase iniziale (0.x). Le correzioni di sicurezza vengono applicate all'ultima versione pubblicata e al branch `main`.

## Segnalare una vulnerabilità

Non aprire una issue pubblica. Inviare una segnalazione privata al maintainer del repository con:

- descrizione e impatto;
- versione/commit;
- passi di riproduzione o PoC;
- configurazione (browser/Node/broker);
- eventuale proposta di fix.

Non includere dati personali o credenziali reali. Se il repository non ha ancora un canale privato configurato, contattare il proprietario del repository GitHub.

## Cosa aspettarsi

- Conferma di ricezione appena possibile.
- Valutazione dell'impatto e piano di correzione.
- Coordinamento della disclosure dopo il fix.

## Ambito

In ambito: protocollo, handshake, capability, cifratura dei frame, signaling, RPC, fallback, ACL/topic, bootstrap, adapter Angular/NestJS, dipendenze.

Fuori ambito: vulnerabilità del broker non configurato dall'utente, XSS nell'applicazione ospite, configurazioni insicure documentate come demo (credenziali pubbliche, HTTP locale), DoS di rete generico.

## Stato di revisione

L'handshake e il formato capability usano primitive WebCrypto standard ma non hanno ancora avuto un audit crittografico indipendente. Le segnalazioni su debolezze del protocollo sono particolarmente benvenute.

## Segreti

Non committare mai:

- token applicativi reali;
- password MQTT di produzione;
- chiavi private;
- certificati con chiavi;
- file `.data/` con identità server.

Le credenziali in `deployment/mosquitto` sono esclusivamente demo locali.
