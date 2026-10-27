# EMQX (alternativa)

P2PLink non dipende da EMQX e non usa estensioni proprietarie. EMQX è utile quando servono JWT/HTTP authentication, ACL dinamiche e più repliche.

Esempio minimo non configurato per la produzione:

```yaml
services:
  emqx:
    image: emqx/emqx:5
    ports:
      - "1883:1883"
      - "8084:8084" # MQTT over WSS (configurare TLS)
      - "18083:18083" # dashboard
```

Checklist:

- abilitare TLS per 8883 e WSS per 8084;
- configurare autenticazione JWT o HTTP (non anonymous);
- emettere credenziali/token a breve scadenza dal bootstrap;
- definire ACL per `p2plink/v1/{tenant}/{serverId}/session/{clientId}/c2s` e `s2c`;
- verificare la licenza BSL 1.1 delle release EMQX 5.9+ prima dell'uso commerciale;
- testare la revoca delle credenziali.

La documentazione ufficiale è la fonte autorevole per la versione installata: le API di autenticazione e autorizzazione cambiano tra 5.x e 6.x.
