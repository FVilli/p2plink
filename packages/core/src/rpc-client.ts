import { P2PLinkError, P2PLinkErrorCodes } from "./errors.js";
import { createEnvelope, encodeEnvelopeJson } from "./protocol.js";
import type { Envelope, EventPayload } from "./protocol-types.js";
import type {
  TransportKind,
  RpcContract,
  RequestOptions,
  Unsubscribe,
  RpcRequest,
  RpcResponse,
  RequestArgs,
  EventContract,
} from "./types.js";
import { noopLogger, type Logger } from "./types.js";

export type RpcSend = (
  envelope: Envelope,
  options?: { via?: TransportKind },
) => Promise<TransportKind>;

interface PendingRequest {
  id: string;
  method: string;
  envelope: Envelope;
  idempotent: boolean;
  attempted: boolean;
  sent: boolean;
  inFlight: boolean;
  needsRetry: boolean;
  lastTransport: TransportKind | null;
  attempts: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanupAbort?: () => void;
}

export interface RpcClientOptions {
  sessionId: string;
  send: RpcSend;
  timeoutMs: number;
  maxPendingRequests: number;
  maxPayloadBytes?: number;
  logger?: Logger;
  onPendingChange?: (count: number) => void;
  idFactory?: () => string;
}

export class RpcClient<C extends RpcContract, E extends EventContract> {
  private readonly options: RpcClientOptions;
  private readonly logger: Logger;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<keyof E & string, Set<(payload: unknown) => void>>();
  private readonly eventListeners = new Set<(event: string, payload: unknown) => void>();
  private closed = false;

  constructor(options: RpcClientOptions) {
    this.options = options;
    this.logger = options.logger ?? noopLogger;
  }

  request<K extends keyof C & string>(
    method: K,
    ...args: RequestArgs<C, K>
  ): Promise<RpcResponse<C, K>> {
    const [request, options] = args as [RpcRequest<C, K>?, RequestOptions?];
    return this.sendRequest<RpcResponse<C, K>>(method, request, options ?? {});
  }

  private sendRequest<R>(method: string, request: unknown, options: RequestOptions): Promise<R> {
    if (this.closed) {
      return Promise.reject(new P2PLinkError(P2PLinkErrorCodes.CLOSED, "Client is closed"));
    }
    if (this.pending.size >= this.options.maxPendingRequests) {
      return Promise.reject(
        new P2PLinkError(
          P2PLinkErrorCodes.RATE_LIMITED,
          `Too many pending requests (${this.options.maxPendingRequests})`,
          { retryable: true },
        ),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(new P2PLinkError(P2PLinkErrorCodes.ABORTED, "Request aborted"));
    }
    const id = this.options.idFactory?.() ?? globalThis.crypto.randomUUID();
    const envelope = createEnvelope(
      "request",
      this.options.sessionId,
      { method, params: request ?? null },
      { id, ...(options.idempotencyKey === undefined ? {} : { idem: options.idempotencyKey }) },
    );
    try {
      encodeEnvelopeJson(envelope, this.options.maxPayloadBytes ?? 64 * 1024);
    } catch (error) {
      return Promise.reject(P2PLinkError.from(error));
    }
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    return new Promise<R>((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        method,
        envelope,
        idempotent: options.idempotent ?? false,
        attempted: false,
        sent: false,
        inFlight: false,
        needsRetry: false,
        lastTransport: null,
        attempts: 0,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => {
          this.onTimeout(pending);
        }, timeoutMs),
      };
      pending.timer.unref?.();
      this.pending.set(id, pending);
      this.options.onPendingChange?.(this.pending.size);
      if (options.signal) {
        const onAbort = (): void => {
          this.rejectPending(
            pending,
            new P2PLinkError(P2PLinkErrorCodes.ABORTED, "Request aborted"),
          );
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }
      void this.transmit(pending);
    });
  }

  private async transmit(pending: PendingRequest): Promise<void> {
    if (!this.pending.has(pending.id)) return;
    if (pending.inFlight) {
      pending.needsRetry = true;
      return;
    }
    pending.inFlight = true;
    pending.attempted = true;
    pending.attempts += 1;
    try {
      const transport = await this.options.send(pending.envelope);
      pending.sent = true;
      pending.lastTransport = transport;
    } catch (error) {
      const normalized = P2PLinkError.from(error);
      // A request that was never accepted by a transport is definitely not sent.
      if (normalized.code === P2PLinkErrorCodes.OFFLINE) {
        this.rejectPending(pending, normalized);
        return;
      }
      if (!pending.idempotent) {
        // Unknown outcome: keep the pending entry until timeout so a late
        // response can still resolve it, but never retransmit automatically.
        this.logger.warn("request send failed; awaiting outcome", {
          method: pending.method,
          error: normalized.message,
        });
        return;
      }
      this.logger.debug("idempotent request send failed", {
        method: pending.method,
        error: normalized.message,
      });
    } finally {
      pending.inFlight = false;
      if (
        pending.needsRetry &&
        pending.idempotent &&
        pending.attempts < 4 &&
        this.pending.has(pending.id)
      ) {
        pending.needsRetry = false;
        queueMicrotask(() => {
          void this.transmit(pending);
        });
      }
    }
  }

  /** Called by the transport manager whenever the active transport changes. */
  handleTransportChange(from: TransportKind | null, to: TransportKind | null): void {
    if (to === null || from === to) return;
    for (const pending of this.pending.values()) {
      if (!pending.idempotent || pending.lastTransport === to) continue;
      if (pending.inFlight || !pending.sent) {
        // A send may still complete on the old transport. Re-evaluate when it
        // settles instead of losing the failover opportunity.
        pending.needsRetry = true;
        continue;
      }
      if (pending.attempts >= 4) {
        this.rejectPending(
          pending,
          new P2PLinkError(
            P2PLinkErrorCodes.OUTCOME_UNKNOWN,
            "Idempotent request could not be retransmitted",
            { retryable: true, outcomeUnknown: true },
          ),
        );
        continue;
      }
      this.logger.debug("retransmitting idempotent request", {
        method: pending.method,
        from: pending.lastTransport,
        to,
      });
      pending.needsRetry = false;
      queueMicrotask(() => {
        void this.transmit(pending);
      });
    }
  }

  handleEnvelope(envelope: Envelope): void {
    if (envelope.sid !== this.options.sessionId) return;
    if (envelope.type === "event") {
      const payload = envelope.payload as EventPayload;
      for (const listener of this.listeners.get(payload.event as keyof E & string) ?? []) {
        try {
          listener(payload.data);
        } catch (error) {
          this.logger.error("event listener failed", {
            event: payload.event,
            error: P2PLinkError.from(error).message,
          });
        }
      }
      for (const listener of this.eventListeners) {
        try {
          listener(payload.event, payload.data);
        } catch {
          // Ignore listener errors.
        }
      }
      return;
    }
    if (envelope.type !== "response" && envelope.type !== "error") return;
    if (!envelope.cid) return;
    const pending = this.pending.get(envelope.cid);
    if (!pending) return;
    this.pending.delete(envelope.cid);
    if (pending.timer) clearTimeout(pending.timer);
    pending.cleanupAbort?.();
    this.options.onPendingChange?.(this.pending.size);
    if (envelope.type === "error") {
      pending.reject(P2PLinkError.fromSerialized(envelope.payload as never));
    } else {
      pending.resolve(envelope.payload);
    }
  }

  on<K extends keyof E & string>(event: K, listener: (payload: E[K]) => void): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const wrapped = listener as (payload: unknown) => void;
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }

  onAnyEvent(listener: (event: string, payload: unknown) => void): Unsubscribe {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  failAll(error: P2PLinkError): void {
    for (const pending of [...this.pending.values()]) {
      this.rejectPending(pending, error);
    }
  }

  close(): void {
    this.closed = true;
    this.failAll(new P2PLinkError(P2PLinkErrorCodes.CLOSED, "Session closed"));
    this.listeners.clear();
    this.eventListeners.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private onTimeout(pending: PendingRequest): void {
    if (!this.pending.has(pending.id)) return;
    const outcomeUnknown = pending.attempted && !pending.idempotent;
    this.rejectPending(
      pending,
      new P2PLinkError(
        outcomeUnknown ? P2PLinkErrorCodes.OUTCOME_UNKNOWN : P2PLinkErrorCodes.TIMEOUT,
        outcomeUnknown
          ? `Request ${pending.method} timed out; the outcome is unknown`
          : `Request ${pending.method} timed out`,
        { outcomeUnknown, retryable: pending.idempotent || !pending.sent },
      ),
    );
  }

  private rejectPending(pending: PendingRequest, error: P2PLinkError): void {
    if (!this.pending.delete(pending.id)) return;
    clearTimeout(pending.timer);
    pending.cleanupAbort?.();
    this.options.onPendingChange?.(this.pending.size);
    pending.reject(error);
  }
}
