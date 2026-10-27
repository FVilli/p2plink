# Broker MQTT

P2PLink richiede un broker MQTT standard con:

- MQTT 3.1.1 o 5;
- TLS per il traffico Node (`mqtts://`) e WSS per il browser;
- autenticazione obbligatoria;
- ACL per topic;
- limite di payload coerente con `maxFrameBytes` (default 256 KiB).

Nessuna estensione proprietaria è necessaria.

## Mosquitto di sviluppo

File inclusi:

- `deployment/mosquitto/docker-compose.yml`
- `deployment/mosquitto/mosquitto.conf`
- `deployment/mosquitto/aclfile`
- `deployment/mosquitto/passwd`

```bash
pnpm broker:up
# 1883/tcp, 9001/ws
```

Credenziali demo (pubbliche, solo sviluppo):

| Utente                | Password               | Uso                  |
| --------------------- | ---------------------- | -------------------- |
| `p2plink-server`      | `server-dev-password`  | server               |
| `client-demo`         | `demo-dev-password`    | demo browser/Angular |
| `client-test-1`       | `client1-dev-password` | test                 |
| `client-test-2`       | `client2-dev-password` | test                 |
| `client-bench-1..100` | `bench-dev-password`   | benchmark            |

Non usare queste credenziali fuori da localhost.

## Configurazione

```conf
persistence false
allow_anonymous false
password_file /mosquitto/config/passwd
acl_file /mosquitto/config/aclfile
max_packet_size 262144
message_size_limit 262144

listener 1883 0.0.0.0

listener 9001 0.0.0.0
protocol websockets
```

In produzione aggiungere TLS:

```conf
listener 8883 0.0.0.0
cafile   /mosquitto/certs/ca.pem
certfile /mosquitto/certs/server.pem
keyfile  /mosquitto/certs/server.key

listener 8084 0.0.0.0
protocol websockets
cafile   /mosquitto/certs/ca.pem
certfile /mosquitto/certs/server.pem
keyfile  /mosquitto/certs/server.key
```

Il browser deve usare `wss://`; non è possibile disattivare la verifica del certificato da JavaScript.

## ACL

```text
user p2plink-server
topic read  p2plink/v1/+/+/session/+/c2s
topic write p2plink/v1/+/+/session/+/s2c
topic write p2plink/v1/+/+/signal/+/s2c

pattern write p2plink/v1/+/+/session/%u/c2s
pattern read  p2plink/v1/+/+/session/%u/s2c
pattern read  p2plink/v1/+/+/signal/%u/s2c
```

- `%u` è lo username MQTT verificato dal password file.
- La demo assegna `username = clientId`, quindi un client non può pubblicare/leggere il namespace di un altro.
- Il server può leggere tutti i `c2s` e scrivere tutti i `s2c` del tenant/server.
- Nessun altro topic è consentito: l'ACL è deny-by-default.

**Limite importante:** con un password file statico il broker non impedisce a un utente di scegliere un client ID diverso dallo username. P2PLink verifica che il `clientId` nel client-hello coincida con quello firmato dalla capability e rifiuta il resto; i payload restano cifrati. Per un isolamento forte dei metadati usare credenziali dinamiche con binding username/clientId.

## Credenziali a breve scadenza

P2PLink espone:

```ts
mqttCredentials: async ({ clientId, subject, identityFingerprint, expiresAt }) => {
  return {
    url: "wss://broker.example.com/mqtt",
    username: clientId,
    password: await mintBrokerPassword({ clientId, subject, expiresAt }),
  };
};
```

Opzioni:

1. **Mosquitto Dynamic Security** (ufficiale): utenti/client/ruoli live, ACL e disabilitazione. Non ha una TTL nativa verificata: pianificare la scadenza esternamente.
2. **mosquitto-go-auth**: backend HTTP/JWT/DB. Il progetto upstream è archiviato nel 2025; valutare fork/manutenzione e build nativa.
3. **EMQX 5/6**: JWT con `exp`/`nbf`, claim ACL, HTTP authorization. Adatto a installazioni più grandi; verificare la licenza BSL 1.1 dalla 5.9.

L'interfaccia `mqttCredentials` è il punto di integrazione: P2PLink non implementa un identity provider né un gestore utenti.

## Multi-tenant

```text
p2plink/v1/{tenant}/{serverId}/...
```

- `tenant` è un namespace infrastrutturale, non un modello di multi-tenancy applicativa.
- ACL possono limitare tenant/server.
- Server con lo stesso `serverId` e tenant condividono i topic: in produzione usare identità/capability condivise o serverId distinti. Due processi demo con lo stesso serverId **non** sono supportati (entrambi ricevono gli handshake e uno rifiuta l'altro).
- Per più repliche servono:
  - chiave identità server condivisa;
  - `CapabilityStore` condiviso (nonce monouso);
  - `IdempotencyStore` condiviso;
  - un unico owner della sessione per clientId oppure sticky routing.

## Limiti broker

- `max_packet_size` e `message_size_limit` devono essere >= `maxFrameBytes` più l'overhead MQTT.
- Impostare un limite connessioni coerente con `maxSessions`.
- Abilitare `max_keepalive`/timeout ragionevoli.
- Non usare `retain` per SDP/ICE: P2PLink non lo fa.
- QoS 1 è sufficiente; QoS 2 aggiunge overhead senza garantire exactly-once applicativo.
- Le code MQTT non devono crescere senza limite: P2PLink limita le richieste pendenti e il payload.

## Checklist produzione

- [ ] TLS/WSS con certificato valido.
- [ ] `allow_anonymous false`.
- [ ] ACL least-privilege per server e client.
- [ ] Credenziali MQTT brevi e revocabili.
- [ ] Bootstrap HTTPS con autenticazione applicativa e rate limiting.
- [ ] `capabilityTtlMs` breve (default 60 s).
- [ ] Store capability/idempotenza condivisi se più repliche.
- [ ] Limiti payload allineati tra broker, client e server.
- [ ] Monitoring connessioni, errori auth, handshake rifiutati, sessioni attive.
- [ ] Backup/rotazione chiave identità server.
- [ ] Test di revoca credenziali e riavvio broker.

## EMQX

P2PLink non usa nulla di specifico di EMQX. Per una configurazione JWT:

- firmare un JWT con claim `clientid`/`username` e ACL;
- configurare l'autenticazione JWT e l'authorization;
- far restituire al bootstrap un token JWT come password o username/password accettati dal broker;
- verificare la disconnessione alla scadenza del token.

Consultare la documentazione EMQX per la versione installata: le API cambiano tra 5.x e 6.x.
