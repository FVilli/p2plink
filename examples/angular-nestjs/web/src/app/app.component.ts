import { Component, computed, effect, inject, signal } from "@angular/core";
import { P2PLinkService } from "@p2plink/angular";
import { apiBase } from "./identity.js";

interface Item {
  id: string;
  name: string;
}

interface DemoRpc {
  "data.list": {
    request: void;
    response: {
      items: Item[];
      subject: string;
      transport: string;
      sessionId: string;
    };
  };
  "data.add": {
    request: { name: string };
    response: Item;
  };
  "system.info": {
    request: void;
    response: Record<string, unknown>;
  };
}

interface DemoEvents {
  "data.updated": { items: Item[] };
  "server.tick": { at: string };
}

@Component({
  selector: "app-root",
  standalone: true,
  template: `
    <main>
      <header>
        <h1>P2PLink</h1>
        <p class="subtitle">Angular 22 ↔ NestJS 12 · WebRTC con fallback MQTT</p>
      </header>

      <section class="panel">
        <div class="status-row">
          <span class="badge" [attr.data-status]="status().status">{{ status().status }}</span>
          <span class="muted">transport: {{ status().transport ?? "—" }}</span>
          <span class="muted"
            >rtt: {{ status().rttMs === null ? "—" : status().rttMs + " ms" }}</span
          >
          <span class="muted">pending: {{ status().pendingRequests }}</span>
        </div>
        <div class="status-row">
          <span class="mono muted">session: {{ status().sessionId ?? "—" }}</span>
          <span class="mono muted">client: {{ status().clientId ?? "—" }}</span>
        </div>
        @if (errorMessage()) {
          <div class="error">{{ errorMessage() }}</div>
        }
      </section>

      <section class="panel">
        <div class="toolbar">
          <button (click)="refresh()" [disabled]="busy()">Aggiorna dati</button>
          <button (click)="add()" [disabled]="busy()">Aggiungi elemento</button>
          <button (click)="info()" [disabled]="busy()">Info sessione</button>
          <button class="danger" (click)="dropP2P()">Simula guasto P2P</button>
          <button (click)="emitEvent()">Invia evento</button>
          <button (click)="suspend()" [disabled]="busy() || status().status === 'offline'">
            Sospendi rete
          </button>
          <button (click)="resume()" [disabled]="busy() || status().status !== 'offline'">
            Riconnetti
          </button>
        </div>

        @if (items().length > 0) {
          <ul class="items">
            @for (item of items(); track item.id) {
              <li>
                <span>{{ item.name }}</span
                ><span>{{ item.id }}</span>
              </li>
            }
          </ul>
        } @else {
          <p class="muted">Nessun dato caricato.</p>
        }
      </section>

      <section class="panel">
        <h2>Eventi e log</h2>
        <pre class="log">@for (line of logs(); track $index) {{{ line }}
}</pre>
      </section>
    </main>
  `,
})
export class AppComponent {
  private readonly link = inject(P2PLinkService) as P2PLinkService<DemoRpc, DemoEvents>;

  readonly status = this.link.status;
  readonly items = signal<Item[]>([]);
  readonly logs = signal<string[]>([]);
  readonly busy = signal(false);
  readonly errorMessage = computed(
    () => this.link.error()?.message ?? this.link.lastError()?.message ?? "",
  );

  private loaded = false;

  constructor() {
    effect(() => {
      const status = this.status();
      console.info(
        `[status] ${status.status} transport=${status.transport} error=${status.lastError?.message ?? ""}`,
      );
    });
    this.link.on("data.updated", (payload) => {
      this.items.set(payload.items);
      this.log(`evento data.updated (${payload.items.length} elementi)`);
    });
    this.link.on("server.tick", (payload) => this.log(`evento server.tick ${payload.at}`));

    effect(() => {
      const status = this.link.connectionStatus();
      if ((status === "p2p" || status === "mqtt") && !this.loaded) {
        this.loaded = true;
        void this.refresh();
      }
      if (status === "offline" || status === "closed") this.loaded = false;
    });
  }

  async refresh(): Promise<void> {
    await this.run("data.list");
  }

  async add(): Promise<void> {
    await this.run("data.add", { name: `Elemento ${new Date().toLocaleTimeString()}` });
  }

  async info(): Promise<void> {
    await this.run("system.info");
  }

  async dropP2P(): Promise<void> {
    try {
      const response = await fetch(`${apiBase()}/debug/drop-p2p`, { method: "POST" });
      this.log(`guasto P2P simulato: HTTP ${response.status}`);
    } catch (error) {
      this.log(`errore simulazione: ${String(error)}`);
    }
  }

  async emitEvent(): Promise<void> {
    try {
      const response = await fetch(`${apiBase()}/debug/emit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "server.tick", data: { at: new Date().toISOString() } }),
      });
      this.log(`evento inviato: HTTP ${response.status}`);
    } catch (error) {
      this.log(`errore evento: ${String(error)}`);
    }
  }

  async suspend(): Promise<void> {
    this.busy.set(true);
    try {
      await this.link.suspend();
      this.log("rete sospesa");
    } finally {
      this.busy.set(false);
    }
  }

  async resume(): Promise<void> {
    this.busy.set(true);
    try {
      await this.link.resume();
      this.log("rete ripristinata");
    } catch (error) {
      this.log(`ripristino fallito: ${String(error)}`);
    } finally {
      this.busy.set(false);
    }
  }

  private async run(
    method: keyof DemoRpc & string,
    request?: DemoRpc[keyof DemoRpc]["request"],
  ): Promise<void> {
    this.busy.set(true);
    try {
      if (method === "data.list") {
        const result = await this.link.request("data.list");
        this.items.set(result.items);
        this.log(`data.list via ${result.transport} (${result.subject})`);
      } else if (method === "data.add") {
        const result = await this.link.request("data.add", request as { name: string }, {
          idempotent: true,
          idempotencyKey: crypto.randomUUID(),
        });
        this.log(`data.add → ${result.name}`);
      } else {
        const result = await this.link.request("system.info");
        this.log(`system.info ${JSON.stringify(result)}`);
      }
    } catch (error) {
      this.log(`errore ${method}: ${String(error)}`);
    } finally {
      this.busy.set(false);
    }
  }

  private log(message: string): void {
    const line = `${new Date().toLocaleTimeString()} ${message}`;
    this.logs.update((lines) => [line, ...lines].slice(0, 200));
  }
}
