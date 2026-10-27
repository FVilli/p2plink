# Network tests

Il benchmark e i test di trasporto usano loopback. NAT reale, CGNAT, STUN/TURN, cambio Wi-Fi/mobile e perdita di pacchetti richiedono un ambiente esterno.

Procedura manuale suggerita:

1. distribuire la demo dietro HTTPS/WSS con STUN configurato;
2. eseguire i client da due reti diverse;
3. verificare `transport = p2p` o fallback `mqtt`;
4. introdurre perdita/ritardo con `tc netem` su una rete di test;
5. verificare heartbeat, fallback, ripristino e assenza di mutazioni duplicate.

Non dichiarare questi scenari testati finché non sono stati eseguiti.
