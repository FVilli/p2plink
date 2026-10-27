# Demo Mosquitto

Broker singleton della demo.

```bash
docker compose -f demo/deployment/mosquitto/docker-compose.yml up -d
```

- TCP: `mqtt://127.0.0.1:1884`
- WebSocket: `ws://127.0.0.1:9002`
- utente: `demo`
- password: `demo-pass`
- namespace: `p2plink-demo/#`

Queste credenziali sono pubbliche e valgono solo per la demo locale. In produzione usare TLS/WSS, credenziali a breve scadenza e ACL più strette.
