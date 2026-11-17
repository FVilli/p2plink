# Deploy su `ace.local`

Guida operativa, in italiano, per il deployment di P2PLink e come modello riutilizzabile per altri progetti. I valori che identificano l'installazione osservata sono riportati esplicitamente; password, token, chiavi e valori `.env` restano sempre fuori dalla documentazione.

> **Ambito e sicurezza.** Questa guida descrive una procedura verificabile, non concede autorizzazione a eseguirla. Commit, push, migrazioni e deploy richiedono autorizzazione esplicita del responsabile.

## 0. Operazioni eseguite su P2PLink

Riepilogo delle attività effettivamente osservate in questo progetto; non costituisce un'autorizzazione riutilizzabile:

- Creato il workflow GitHub Actions per pubblicare l'immagine del Registry su GHCR.
- Distribuito su `ace.local`, nel progetto Compose `p2plink-server`, lo stack Registry, PostgreSQL e Mosquitto.
- Configurati tramite Traefik il routing/TLS del Registry, MQTT TLS e MQTT WebSocket.
- Applicate le migrazioni Prisma e il seed del Registry.
- Serviti Swagger e l'amministrazione Angular dall'immagine del Registry.
- Aggiunto Watchtower con filtraggio tramite label e polling ogni 300 secondi.
- Distribuiti i tre frontend demo su Firebase Hosting.
- Verificati gli endpoint di health, Swagger e amministrazione.

## 1. Topologia verificata

```text
repo locale
   │ commit/push
   ▼
GitHub (branch main) ── workflow Registry image ──► GHCR
                                                  ghcr.io/fvilli/p2plink-registry
                                                         │ pull/recreate
                                                         ▼
ace.local ── ~/my-easy-server (branch ace-ubuntu-server-24)
           compose project: p2plink-server
           Traefik edge network: my-easy-server_default
           ├─ registry + admin UI
           ├─ PostgreSQL
           └─ Mosquitto (MQTT/WSS)
```

- Il repository locale è la fonte delle modifiche; GitHub è la fonte del workflow e dell'immagine.
- Il workflow `.github/workflows/registry-image.yml` pubblica `ghcr.io/fvilli/p2plink-registry:latest` e un tag `sha-*` su push a `main` quando cambiano i file previsti. La build osservata è `linux/amd64`.
- Su `ace.local` il progetto vive in `~/my-easy-server`, sul branch **`ace-ubuntu-server-24`**, ed è gestito dal progetto Compose **`p2plink-server`**. Non cambiare branch per “provare” un deploy.
- Traefik è il punto d'ingresso TLS e usa la rete esterna `my-easy-server_default`. I servizi non devono pubblicare direttamente all'esterno porte amministrative o PostgreSQL.
- Su `ace.local` la persistenza remota usa i percorsi `../volumes/p2plink-postgres`, `../volumes/p2plink-registry` e `../volumes/p2plink-mosquitto` (relativi alla directory del progetto Compose): rispettivamente database PostgreSQL, chiavi/dati del registry e dati Mosquitto. Il compose locale `apps/p2plink-registry/docker-compose.yml` usa invece volumi Docker nominati (`registry-db`, `registry-data`, `broker-data`); non confondere i due assetti.
- L'immagine del registry serve anche l'app amministrativa (`/admin/`): non è un servizio frontend separato.

## 2. Endpoint P2PLink

Endpoint pubblici dell'installazione osservata:

| Uso | URL |
|---|---|
| Registry | `https://p2plink-registry.fvsg.mqu.it` |
| MQTT TLS | `mqtts://p2plink-mqtt.fvsg.mqu.it:443` |
| MQTT WebSocket | `wss://p2plink-mqtt-ws.fvsg.mqu.it/mqtt` |
| Health | `https://p2plink-registry.fvsg.mqu.it/health` |
| Swagger (redirect) | `https://p2plink-registry.fvsg.mqu.it/swagger` |
| OpenAPI UI | `https://p2plink-registry.fvsg.mqu.it/v1/swagger` |
| Admin app | `https://p2plink-registry.fvsg.mqu.it/admin/` |

`/health` deve restituire una risposta HTTP positiva; la pagina OpenAPI e l'admin servono inoltre a distinguere un registry vivo da un proxy o da un'immagine incompleta.

## 3. Prerequisiti e credenziali

### Locale

- Git, Node.js compatibile con il progetto (P2PLink richiede Node `>=22`), pnpm, Docker e accesso al repository GitHub.
- Accesso al progetto Firebase solo per il frontend, se previsto.
- Working tree pulito o una lista precisa delle modifiche autorizzate.

### `ace.local`

- Accesso SSH all'host, permesso a usare Docker Compose e accesso pull a GHCR.
- Repository già presente in `~/my-easy-server`, branch `ace-ubuntu-server-24`.
- Traefik attivo sulla rete esterna `my-easy-server_default` e DNS/TLS già configurati per i tre hostname pubblici.
- Volumi esistenti e backup verificabili prima di interventi sul database o sulla chiave del registry.

### Credenziali

- Conservare tutti i segreti esclusivamente nel file `.env` sul server, con permessi `chmod 600`; non committarlo e non incollarne i valori in terminale condivisi, issue o log.
- Usare almeno: password PostgreSQL, `JWT_SECRET` casuale e persistente, password admin MQTT, password admin seed, eventuale utenza/password GHCR e credenziali SMTP. I nomi canonici P2PLink includono `POSTGRES_PASSWORD`, `JWT_SECRET`, `MQTT_ADMIN_PASSWORD`, `SEED_ADMIN_USERNAME`, `SEED_ADMIN_PASSWORD`, `REGISTRY_PUBLIC_URL`, `MQTT_PUBLIC_URL`, `CORS_ORIGIN`.
- `REGISTRY_KEY_FILE` punta a un file persistente (`/data/registry-key.json` nel compose di riferimento): proteggerlo e farne backup. La sua perdita cambia l'identità crittografica del registry.
- Separare la password usata per il login admin da quella del broker e da quella PostgreSQL. La password admin iniziale viene dal seed: cambiare il valore nel `.env` non implica necessariamente aggiornare un utente già esistente.

## 4. Regole non negoziabili

1. **Mai cambiare branch** su `ace.local`; verificare prima `git branch --show-current` e abortire se diverso da `ace-ubuntu-server-24`.
2. Modificare soltanto i file del proprio progetto. Non toccare configurazioni condivise di Traefik, altri compose, volumi o repository senza incarico specifico.
3. Segreti soltanto in `.env` (o nel secret manager già approvato); mai nei file versionati, comandi salvati, screenshot o log.
4. Mai usare `docker compose down -v`, `docker volume rm`, reset del database o comandi distruttivi senza autorizzazione separata e backup verificato. In particolare, `down -v` cancella la persistenza.
5. Non inserire segreti in log: redigere output, URL con credenziali e variabili d'ambiente prima di condividerli.
6. Commit, push, deploy e migrazione richiedono autorizzazione esplicita. Un comando riuscito non equivale a verifica dell'esito esterno.
7. Una sola persona/agente scrive in una working directory alla volta; delegare ownership, file vietati, test e criterio di accettazione.
8. Verificare dall'esterno DNS, TLS, endpoint, comportamento applicativo e versione dell'immagine dopo il deploy.

## 5. Flusso completo P2PLink

### 5.1 Controlli locali

```bash
cd /home/federico/develop/p2plink
git status --short
git branch --show-current
pnpm install --frozen-lockfile
pnpm --filter p2plink-registry typecheck
pnpm --filter p2plink-registry test
pnpm --filter p2plink-registry build
docker compose -f apps/p2plink-registry/docker-compose.yml config
```

Il compose locale usa build locali e non è una prova del routing Traefik. Verificare anche la configurazione frontend interessata e documentare ogni test non eseguito.

### 5.2 Commit, push e immagine

```bash
git diff --check
git diff --stat
# Solo dopo autorizzazione:
git add <soli-file-autorizzati>
git commit -m "<messaggio>"
git push origin main
```

Attendere il completamento del workflow **Registry image (GHCR)** in GitHub prima di intervenire sul server. Controllare il commit e il digest/tag pubblicato; non assumere che `latest` sia già aggiornato.

### 5.3 Migrazione e seed espliciti su `ace.local`

```bash
ssh <utente>@ace.local
cd ~/my-easy-server
git branch --show-current                         # deve essere ace-ubuntu-server-24
chmod 600 .env
set -a; . ./.env; set +a                         # non stampare l'ambiente

docker compose -p p2plink-server config
# Dopo che l'immagine GHCR è disponibile e con autorizzazione:
docker compose -p p2plink-server pull p2plink-registry p2plink-migrate p2plink-seed
docker compose -p p2plink-server run --rm p2plink-migrate
# Il seed è idempotente secondo l'applicazione; non mostrare password:
docker compose -p p2plink-server run --rm p2plink-seed
```

I nomi sopra sono quelli del compose remoto su `ace.local`. Il compose locale `apps/p2plink-registry/docker-compose.yml` usa invece `registry`, `registry-migrate` e `registry-seed`. Non eseguire la migrazione contro un'immagine vecchia o un database non raggiungibile.

### 5.4 Pull, ricreazione e verifica

```bash
docker compose -p p2plink-server pull p2plink-registry p2plink-migrate p2plink-seed
# Dopo aver verificato migrate e seed, ricreare soltanto l'applicazione:
docker compose -p p2plink-server up -d --no-build p2plink-registry
docker compose -p p2plink-server ps p2plink-registry
docker compose -p p2plink-server logs --tail=100 p2plink-registry
```

> **Attenzione:** `docker compose up -d` senza un servizio esplicito può avviare o rieseguire anche i servizi one-shot di migrazione e seed, in base alla configurazione e allo stato del progetto. Preferire i comandi espliciti di migrazione e seed nella sezione 5.3, quindi verificare il risultato e ricreare soltanto `p2plink-registry`.

Poi verificare da una macchina esterna (senza stampare segreti):

```bash
curl -fsS https://p2plink-registry.fvsg.mqu.it/health
curl -fsSI https://p2plink-registry.fvsg.mqu.it/swagger
curl -fsSI https://p2plink-registry.fvsg.mqu.it/v1/swagger
curl -fsSI https://p2plink-registry.fvsg.mqu.it/admin/
```

Controllare inoltre TLS, MQTT TLS sulla porta `443`, MQTT WebSocket sul path `/mqtt`, login admin con credenziale autorizzata, provisioning di un peer e assenza di errori nuovi nei log. Registrare commit, digest, orario, migrazione eseguita e risultato esterno.

### Watchtower

L'installazione osservata usa `WATCHTOWER_POLL_INTERVAL=300` (poll ogni 300 secondi). Watchtower agisce **solo** sui container opportunamente etichettati: scarica l'immagine e ricrea il container. **Non esegue migrazioni Prisma, seed, backup, aggiornamenti di dati o test applicativi.**

Di conseguenza ogni modifica di schema richiede migrazione esplicita prima/durante una rollout compatibile all'indietro. Preferire la sequenza expand → deploy codice compatibile → migrazione/backfill → contract; non pubblicare codice che richieda uno schema nuovo prima che la migrazione sia stata applicata.

## 6. Rollback e gestione dei guasti

- Prima del deploy salvare il digest attuale, stato dei container, versione Git e conferma dei backup dei volumi. Preferire digest immutabili a `latest` per rollback riproducibili.
- Se il nuovo container non è sano: raccogliere `ps`, healthcheck e log redatti; bloccare l'automazione, ripristinare l'immagine precedente per digest e ricreare soltanto il servizio interessato dopo autorizzazione.
- Per fermare temporaneamente gli aggiornamenti automatici, disabilitare/rimuovere la label Watchtower del servizio o arrestare Watchtower secondo la procedura dell'host; non cancellare volumi. Riabilitare solo dopo la verifica.
- Pinning di esempio (sostituire il placeholder con un digest autorizzato):

```yaml
services:
  p2plink-registry:
    image: ghcr.io/fvilli/p2plink-registry@sha256:<DIGEST_AUTORIZZATO>
```

```bash
docker compose -p p2plink-server pull p2plink-registry
docker compose -p p2plink-server up -d --no-build p2plink-registry
```

- Non fare rollback cieco dopo una migrazione non compatibile: il database potrebbe non supportare l'immagine vecchia. Usare migrazioni backward-compatible o una procedura DB approvata; non usare `down -v`.
- Se GHCR non è raggiungibile, non sostituire con una build improvvisata sul server senza autorizzazione; verificare autenticazione, digest e rete.

## 7. Frontend Firebase

I progetti osservati sono `p2plink-demo`, `p2plink-demo-angular` e `p2plink-demo-react`. Eseguire dalla directory `demo/`, dopo autenticazione Firebase, con autorizzazione separata dal deploy server:

```bash
cd /home/federico/develop/p2plink/demo
pnpm install --frozen-lockfile
pnpm run deploy:web       # build mesh + demo/web + Firebase Hosting p2plink-demo
pnpm run deploy:angular   # build mesh + Angular + Firebase Hosting p2plink-demo-angular
pnpm run deploy:react     # build mesh + React + Firebase Hosting p2plink-demo-react
```

Comandi equivalenti espliciti:

```bash
pnpm --filter @p2plink/demo-mesh build
pnpm --filter @p2plink/demo-web build
npx --yes firebase-tools@latest deploy --only hosting --project p2plink-demo
pnpm --filter @p2plink/demo-angular-web run deploy
pnpm --filter @p2plink/demo-react-web run deploy
```

Per un progetto nuovo sostituire project ID e directory `public` nel relativo `firebase.json`; non mettere token Firebase nel repository. Verificare poi il sito pubblicato e invalidare/attendere la cache PWA quando necessario.

## 8. Troubleshooting noto

- **SSH: host key cambiata.** Non disabilitare alla cieca la verifica. Confermare l'identità dell'host tramite un canale affidabile e, solo dopo autorizzazione, aggiornare la voce corretta in `~/.ssh/known_hosts` (`ssh-keygen -R <host>` seguito da una nuova verifica della fingerprint).
- **Registry avvia Fastify ma risponde `notFound`.** Controllare che si stia usando l'immagine corretta e il path Traefik corretto; `/swagger` redirige a `/v1/swagger`, mentre l'admin è `/admin/`. Verificare anche che static admin sia incluso nell'immagine.
- **HTTP 401 admin dopo un seed.** Il login admin usa l'utente/password seed del database, non `MQTT_ADMIN_PASSWORD`, `POSTGRES_PASSWORD` o `JWT_SECRET`. Un seed successivo non necessariamente sovrascrive la password esistente: usare la procedura di reset autorizzata.
- **SMTP.** Verificare host, porta, TLS, mittente e credenziali solo in `.env`; usare il test SMTP dell'applicazione se disponibile e cercare nei log soltanto esito e codici redatti, mai password o token.
- **Watchtower / `DOCKER_API_VERSION`.** Un errore di API indica incompatibilità tra client Watchtower e Docker Engine: controllare versioni e log, impostare una versione compatibile solo secondo la procedura dell'host e non risolvere esponendo indiscriminatamente il socket Docker.
- **PWA mostra una versione vecchia.** Service worker e cache possono mantenere asset precedenti: usare una release/versione asset corretta, controllare DevTools/Application, attendere o forzare l'aggiornamento secondo la policy e verificare in finestra privata.
- **Ordine migrazioni.** Nel compose remoto di `ace.local`, `p2plink-registry` dipende da `p2plink-migrate` e `p2plink-seed`, ma Watchtower non esegue i one-shot. Eseguire e verificare `p2plink-migrate`, poi `p2plink-seed`, quindi pull/recreate di `p2plink-registry`; per schema incompatibile applicare rollout expand/contract. Il compose locale usa invece `registry`, `registry-migrate` e `registry-seed`.

## 9. Template riutilizzabile per un nuovo progetto su `ace.local`

Checklist da copiare in una change/task:

- [ ] Directory dedicata sotto `~/my-easy-server/<progetto>`; nessuna modifica ad altri progetti.
- [ ] Branch server concordato e verificato (`ace-ubuntu-server-24` nell'installazione P2PLink); mai checkout automatico.
- [ ] Nome Compose univoco, ad esempio `<progetto>-server`, e sempre `docker compose -p <progetto>-server ...`.
- [ ] `.env` creato sul server, segreti non versionati, `chmod 600 .env`; nessun secret nei log.
- [ ] Servizi con immagini versionate/pinnate quando possibile; CI pubblica l'immagine in GHCR con digest e architetture dichiarate.
- [ ] Rete esterna Traefik dichiarata e preesistente: `my-easy-server_default` (non ricrearla né eliminarla).
- [ ] Router/host TLS per API, UI e broker configurati in Traefik; niente esposizione pubblica di DB/admin listener.
- [ ] Volumi nominati per DB, chiavi e dati applicativi; backup e restore testati.
- [ ] Healthcheck per DB e app; dipendenze `service_healthy`/`service_completed_successfully` dove applicabili.
- [ ] Servizio di migrazione e seed one-shot separati dall'app; procedura esplicita e idempotente.
- [ ] Label Watchtower solo sui servizi autorizzati; documentare `WATCHTOWER_POLL_INTERVAL` e il fatto che non migra.
- [ ] CI: test, typecheck, build, push GHCR, tag commit e digest; workflow osservabile e rollback definito.
- [ ] Runbook con endpoint health, log redatti, rollback a digest e verifica esterna.
- [ ] Ownership: un solo writer, file posseduti/vietati e autorizzazioni per commit/push/deploy chiaramente assegnate.

Esempio minimo (da adattare, non da copiare senza revisione):

```yaml
services:
  app:
    image: ghcr.io/<org>/<image>@sha256:<DIGEST>
    env_file: .env
    networks: [traefik]
    labels:
      com.centurylinklabs.watchtower.enable: "true"
    healthcheck:
      test: ["CMD", "<health-command>"]
      interval: 30s
      timeout: 5s
      retries: 5
networks:
  traefik:
    external: true
    name: my-easy-server_default
volumes:
  app-data:
```

## 10. Regole per agenti e delega

Coerentemente con `AGENTS.md`: delegare implementazione/pubblicazione a worker o reviewer; definire prima cwd, worktree/branch, file posseduti e vietati, comandi, criteri di accettazione e rapporto atteso. Un solo writer per cwd, niente writer concorrenti sugli stessi file. Il reviewer verifica in modo indipendente; l'orchestratore accetta leggendo diff/stato/rapporti senza modificare, buildare, testare, committare, fare push o deploy direttamente. Ogni worker deve verificare il risultato esterno effettivo, non soltanto l'uscita `0` del comando. Registrare eccezioni quando la delega è impossibile.

## 11. Lezioni apprese e limiti residui

- Il registry pubblicato dal workflow è attualmente **solo `linux/amd64`**: un host ARM non è supportato da questa immagine senza una build multi-arch.
- L'app admin è servita dal container registry; un `notFound` può quindi indicare routing/path o immagine incompleta, non necessariamente un frontend separato guasto.
- `WATCHTOWER_POLL_INTERVAL=300` limita il ritardo nominale del polling, ma non garantisce che pull, recreate, health o rollout siano riusciti.
- Watchtower non esegue migrazioni né seed: lo schema richiede sempre una procedura esplicita e un rollout compatibile.
- `latest` è comodo ma mutabile; per audit e rollback usare tag `sha-*` o digest.
- La persistenza dei volumi non sostituisce backup e test di ripristino; la chiave del registry è parte dello stato critico.
- Le verifiche riportate sono quelle dell'assetto osservato e vanno ripetute dopo cambi di host, Traefik, DNS, CI o immagini.
