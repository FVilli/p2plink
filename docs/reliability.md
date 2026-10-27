# Affidabilità e semantica RPC

## Trasporto affidabile ≠ operazione eseguita una volta

MQTT QoS 1 e SCTP/DataChannel offrono consegna a livello di trasporto, ma un failover, un timeout o un crash del server possono lasciare l'esito applicativo sconosciuto. P2PLink distingue esplicitamente:

- **richiesta inviata** (il frame è stato accettato dal trasporto);
- **risposta ricevuta** (il server ha risposto);
- **effetto applicativo eseguito** (responsabilità dell'handler e dello store di idempotenza).

Non viene mai dichiarato exactly-once senza una configurazione che lo sostenga.

## Request ID e correlation ID

- Ogni `request` ha un `id` stabile (UUID).
- La risposta ha `cid = request.id`.
- Un retry idempotente riusa lo stesso `id` e lo stesso `idem`.
- Il server calcola la chiave di deduplica come `subject + "\0" + clientId + "\0" + method + "\0" + SHA-256(canonicalJson(params)) + "\0" + (idem ?? id)`. La stessa idempotency key usata con metodo o parametri diversi non restituisce il risultato di un'altra operazione.
- La chiave è scoperta dall'identità autenticata: due utenti/client non possono collidere.
- L'autorizzazione applicativa viene eseguita prima della deduplica, anche per una richiesta ritentata.

## Timeout

Livelli:

1. **per richiesta** (`RequestOptions.timeoutMs`);
2. **globale client** (`limits.requestTimeoutMs`, default 15 s);
3. **handler server** (`RpcHandlerOptions.timeoutMs` o default server).

Allo scadere:

- se la richiesta non è mai stata inviata → `TIMEOUT`/`OFFLINE` retryable;
- se è stata inviata ed è idempotente → `TIMEOUT` (safe da ritentare manualmente);
- se è stata inviata ed è mutativa → `OUTCOME_UNKNOWN`, `retryable: false` di default.

`AbortSignal` è supportato sia lato client sia nel contesto handler server.

## Retry policy

Il client **non** ritenta automaticamente una richiesta con effetti collaterali. Regole:

| Situazione                                | Comportamento                                               |
| ----------------------------------------- | ----------------------------------------------------------- |
| Errore prima dell'invio, nessun trasporto | `OFFLINE`                                                   |
| Trasporto cambia, richiesta idempotente   | Reinvio automatico con stesso id                            |
| Trasporto cambia, richiesta mutativa      | Resta pending fino al timeout, poi `OUTCOME_UNKNOWN`        |
| Timeout richiesta mutativa                | `OUTCOME_UNKNOWN`                                           |
| Timeout richiesta idempotente             | `TIMEOUT`, ritentabile                                      |
| Sessione resettata                        | `SESSION_RESET`/`OUTCOME_UNKNOWN`, nessun replay automatico |

Le richieste idempotenti hanno un limite di 4 tentativi di ritrasmissione per singola richiesta.

## Idempotenza

```ts
await client.request("orders.create", order, {
  idempotent: true,
  idempotencyKey: order.clientRequestId,
});
```

Lato server:

```ts
server.register("orders.create", handler, {
  idempotent: true,
  timeoutMs: 10_000,
});
```

Il flag `idempotent` è una dichiarazione dell'applicazione: la libreria non può sapere se un handler è realmente sicuro da ripetere.

### `IdempotencyStore`

```ts
interface IdempotencyStore {
  claim(key: string, ttlMs: number): Promise<IdempotencyClaim>;
  complete(key: string, outcome: StoredRpcOutcome, ttlMs: number): Promise<void>;
  release(key: string): Promise<void>;
}
```

- `claim` deve essere atomico.
- `in-progress`: una richiesta identica è in corso; il server attende fino a 2 s, poi risponde `IDEMPOTENCY_IN_PROGRESS` (retryable).
- `completed`: il server restituisce lo stesso risultato/errore senza rieseguire l'handler.
- `release`: usato quando l'handler fallisce prima di produrre un effetto (es. `FORBIDDEN`).
- Gli errori deterministici vengono memorizzati per evitare riesecuzioni.
- Un timeout dell'handler memorizza `OUTCOME_UNKNOWN`; l'handler può continuare ma il risultato non viene più restituito come successo.

Default: `MemoryIdempotencyStore` con TTL 10 minuti e limite di entry. È adatto a test e a processi singoli non critici.

### Exactly-once con SQLite

Per ottenere una garanzia forte, la registrazione dell'idempotency key e la mutazione applicativa devono essere nella **stessa transazione**. Esempio concettuale con `node:sqlite`:

```ts
import { DatabaseSync } from "node:sqlite";
import type { IdempotencyStore, IdempotencyClaim, StoredRpcOutcome } from "@p2plink/core";

class SqliteIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS p2plink_idempotency (
        key TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        outcome TEXT,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  async claim(key: string, ttlMs: number): Promise<IdempotencyClaim> {
    const now = Date.now();
    this.db.prepare("DELETE FROM p2plink_idempotency WHERE expires_at <= ?").run(now);
    const insert = this.db
      .prepare("INSERT OR IGNORE INTO p2plink_idempotency(key,state,expires_at) VALUES(?,?,?)")
      .run(key, "in-progress", now + ttlMs);
    if (insert.changes === 1) return { status: "claimed" };
    const row = this.db
      .prepare("SELECT state, outcome FROM p2plink_idempotency WHERE key = ?")
      .get(key) as { state: string; outcome: string | null } | undefined;
    if (!row) return { status: "claimed" };
    if (row.state === "in-progress") return { status: "in-progress" };
    return { status: "completed", outcome: JSON.parse(row.outcome ?? "null") as StoredRpcOutcome };
  }

  async complete(key: string, outcome: StoredRpcOutcome, ttlMs: number): Promise<void> {
    this.db
      .prepare(
        "UPDATE p2plink_idempotency SET state='completed', outcome=?, expires_at=? WHERE key=?",
      )
      .run(JSON.stringify(outcome), Date.now() + ttlMs, key);
  }

  async release(key: string): Promise<void> {
    this.db.prepare("DELETE FROM p2plink_idempotency WHERE key=? AND state='in-progress'").run(key);
  }
}
```

Per la transazione applicativa, l'handler deve usare la stessa connessione e racchiudere claim + mutazione + complete in `BEGIN IMMEDIATE … COMMIT`. L'adapter incluso in P2PLink non può imporre la transazione al posto dell'applicazione.

## Errori

Gli errori del server sono tipizzati e serializzati senza stack trace. Un handler che lancia `P2PLinkError` conserva codice, messaggio e flag. Un errore sconosciuto diventa `HANDLER_ERROR` con messaggio generico lato client e log lato server.

Codici utili al chiamante:

- `OUTCOME_UNKNOWN`: non sapere se l'operazione è avvenuta;
- `IDEMPOTENCY_IN_PROGRESS`: ritentare dopo;
- `RATE_LIMITED`: backoff;
- `FORBIDDEN`: autorizzazione applicativa;
- `METHOD_NOT_FOUND`: contratto errato.

## Eventi push

Gli eventi (`emitTo`) sono:

- **best-effort**: nessun ACK, nessun retry;
- **non persistiti**: persi se il client è offline;
- **senza garanzia di ordinamento globale**;
- **possibilmente duplicati** in caso di riconnessione o retry del chiamante;
- **non sostitutivi di una RPC** per operazioni critiche.

L'applicazione deve:

- usare un `event id` e deduplicare;
- risincronizzare via RPC dopo una riconnessione;
- non assumere che un evento perso venga recuperato.

## Limiti di coda

- `maxPendingRequests` (default 64) per client.
- `maxPayloadBytes` (default 64 KiB) prima dell'invio.
- `maxFrameBytes` (default 256 KiB) per frame cifrato.
- `maxQueuedBytes` (default 8 MiB) per la coda WebRTC.
- `maxSessions` (default 500) e `maxHandshakes` (default 50) server.
- Rate limit per sessione (default 50 richieste/s, burst 2×).

Il superamento produce `RATE_LIMITED`, `PAYLOAD_TOO_LARGE` o `OFFLINE`; non viene mai creata una coda illimitata.
