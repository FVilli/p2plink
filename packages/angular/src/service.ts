import { computed, DestroyRef, inject, Injectable, signal } from "@angular/core";
import {
  P2PLinkError,
  type ConnectionSnapshot,
  type ConnectionStatus,
  type EventContract,
  type RequestOptions,
  type RpcContract,
  type RequestArgs,
  type RpcResponse,
  type Unsubscribe,
} from "@p2plink/core";
import type { P2PLinkClient } from "@p2plink/client";
import { P2PLINK_ANGULAR_OPTIONS, P2PLINK_CLIENT, type P2PLinkAngularOptions } from "./config.js";

/**
 * Root Angular service. Connection state is exposed through signals and the
 * client is disconnected automatically when the injector is destroyed.
 */
@Injectable({ providedIn: "root" })
export class P2PLinkService<
  C extends RpcContract = RpcContract,
  E extends EventContract = EventContract,
> {
  readonly client = inject(P2PLINK_CLIENT) as unknown as P2PLinkClient<C, E>;
  readonly status = signal<ConnectionSnapshot>(this.client.getStatus());
  readonly connectionStatus = computed<ConnectionStatus>(() => this.status().status);
  readonly transport = computed(() => this.status().transport);
  readonly rttMs = computed(() => this.status().rttMs);
  readonly pendingRequests = computed(() => this.status().pendingRequests);
  readonly sessionId = computed(() => this.status().sessionId);
  readonly lastError = computed(() => this.status().lastError);
  readonly isConnected = computed(() => {
    const status = this.connectionStatus();
    return status === "p2p" || status === "mqtt";
  });
  readonly isP2P = computed(() => this.connectionStatus() === "p2p");
  /** Error from connect()/resume(), in addition to the transport snapshot. */
  readonly error = signal<P2PLinkError | null>(null);

  private readonly destroyRef = inject(DestroyRef);
  private readonly options = inject(P2PLINK_ANGULAR_OPTIONS, { optional: true }) ?? {};
  private destroyed = false;

  constructor() {
    const unsubscribe = this.client.onStatus((snapshot) => {
      this.status.set(snapshot);
    });
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      unsubscribe();
      void this.client.disconnect().catch(() => undefined);
    });
    if (this.options.autoConnect !== false) {
      queueMicrotask(() => {
        if (!this.destroyed) void this.connect().catch(() => undefined);
      });
    }
  }

  async connect(): Promise<void> {
    this.error.set(null);
    try {
      await this.client.connect();
    } catch (error) {
      this.error.set(P2PLinkError.from(error));
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  async suspend(): Promise<void> {
    await this.client.suspend();
  }

  async resume(): Promise<void> {
    this.error.set(null);
    try {
      await this.client.resume();
    } catch (error) {
      this.error.set(P2PLinkError.from(error));
      throw error;
    }
  }

  request<K extends keyof C & string>(
    method: K,
    ...args: RequestArgs<C, K>
  ): Promise<RpcResponse<C, K>> {
    const call = this.client.request.bind(this.client) as unknown as (
      name: string,
      request?: unknown,
      options?: RequestOptions,
    ) => Promise<RpcResponse<C, K>>;
    const [request, options] = args as unknown as [unknown, RequestOptions | undefined];
    return call(method, request, options);
  }

  on<K extends keyof E & string>(event: K, listener: (payload: E[K]) => void): Unsubscribe {
    return this.client.on(event, listener);
  }
}

export type { P2PLinkAngularOptions };
