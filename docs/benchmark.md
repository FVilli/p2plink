# Benchmark

## Ambiente misurato

| Voce              | Valore                                                |
| ----------------- | ----------------------------------------------------- |
| Data              | 26 ottobre 2026                                       |
| CPU               | AMD Ryzen AI MAX+ 395 w/ Radeon 8060S                 |
| Core              | 32                                                    |
| RAM               | 123 GiB                                               |
| OS                | Linux 7.0.0-38-generic x86_64                         |
| Node.js           | 24.19.0                                               |
| Broker            | Eclipse Mosquitto 2.1.2 in Docker locale              |
| Trasporto         | loopback, `iceServers: []`, nessun STUN/TURN          |
| Architettura test | server e client in **processi separati**, stesso host |

Comando:

```bash
pnpm broker:up
pnpm exec tsx scripts/benchmark.ts
```

Il benchmark avvia `scripts/bench-server.ts` in un processo separato, poi esegue ondate da 1, 10 e 100 client. Ogni client ha identità ECDSA distinta, bootstrap HTTPS locale, connessione MQTT e WebRTC reale.

## Risultati

| Client | Connessione MQTT (mediana / p95) | Tutti P2P | RPC P2P media / p95 | RPC MQTT media | Fallback | Ripristino P2P | RSS client | RSS server | CPU client | CPU server |
| -----: | -------------------------------: | --------: | ------------------: | -------------: | -------: | -------------: | ---------: | ---------: | ---------: | ---------: |
|      1 |                     166 / 166 ms |  1.887 ms |      0,69 / 1,74 ms |       77,98 ms |     3 ms |       4.653 ms |     129 MB |     106 MB |       5,4% |       0,9% |
|     10 |                     142 / 160 ms |  1.879 ms |      0,97 / 1,95 ms |       61,09 ms |     3 ms |       4.720 ms |     145 MB |     129 MB |       8,5% |       2,4% |
|    100 |                     239 / 258 ms |  1.879 ms |     7,94 / 12,26 ms |       84,71 ms |     2 ms |       4.619 ms |     241 MB |     199 MB |      23,7% |      14,9% |

- **Connessione MQTT**: tempo di `client.connect()` fino a sessione autenticata e primo pong MQTT.
- **Tutti P2P**: tempo dall'inizio dell'ondata fino a quando tutti i client hanno `transport = "webrtc"`.
- **RPC P2P**: 5 richieste da 1 KiB per client, eseguite in parallelo tra client.
- **Fallback**: tempo da `dropP2P` lato server a `transport = "mqtt"` sul client.
- **Ripristino**: tempo da `dropP2P` a `transport = "webrtc"` stabile.
- CPU: percentuale di un core, misurata come delta di `process.cpuUsage()` dall'inizio dell'ondata, separatamente per processo client e server.
- Memoria: RSS del processo client e del processo server a fine ondata.
- Risultati grezzi: [benchmark-results.json](benchmark-results.json).

## Interpretazione

- L'MQTT iniziale è dominato da TCP/TLS locale, CONNECT e handshake applicativo (~0,15–0,24 s).
- La promozione P2P richiede ~1,9 s: circa 1 s di `promoteAfterMs` più heartbeat e negoziazione.
- Il fallback esplicito è immediato (2–3 ms) perché il DataChannel viene chiuso: il client riceve subito l'evento. In caso di perdita silenziosa il rilevamento richiede fino a `heartbeatTimeoutMs` (default 15 s).
- Il ripristino è ~4,7–5,5 s, dominato dal cooldown anti-flapping di 5 s e dalla promozione. È una scelta deliberata per evitare oscillazioni.
- L'RTT P2P cresce con il numero di client (0,6 → 7,3 ms) ma resta molto inferiore a MQTT sul loopback (51–77 ms), perché il broker introduce hop e QoS 1.
- 100 client P2P simultanei sono stati raggiunti con successo in questa configurazione.

## Cosa non misura

- NAT reale, CGNAT, STUN/TURN, reti mobili.
- Packet loss, jitter, duplicazione e riordino di rete.
- Throughput massimo, streaming o payload grandi oltre 1 KiB.
- Cluster di broker, più repliche server, sticky routing.
- Consumo memoria a lungo termine (GC, leak) oltre una singola ondata.
- WebView e dispositivi mobili.
- Sicurezza o resistenza a DoS.

## Riproducibilità

I numeri dipendono da CPU, carico, Docker, kernel e versione Node. Non sono una garanzia di produzione. Per confronti, eseguire lo stesso script sullo stesso host e conservare `environment` e `results` prodotti in JSON.

## Nota sulla prima esecuzione

Una prima versione del benchmark eseguiva server e client nello **stesso** processo Node: a 100 client, 85–90 sessioni raggiungevano il P2P e le altre restavano su MQTT, verosimilmente per i limiti di peer/socket del processo condiviso. Separando server e client in processi distinti, 100/100 hanno raggiunto il P2P. Il limite osservato riguarda l'harness, non la libreria; è documentato per trasparenza.
