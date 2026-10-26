import { P2PLinkError, P2PLinkErrorCodes } from "./errors.js";
import type { IdempotencyStore, StoredRpcOutcome } from "./idempotency.js";
import { createEnvelope } from "./protocol.js";
import type { Envelope } from "./protocol-types.js";
import type { JsonObject, Logger, TransportKind } from "./types.js";
import { noopLogger } from "./types.js";
import { sleep } from "./util.js";

export interface RpcIdentity {
  subject: string;
  identityId: string;
  publicKeyJwk: JsonWebKey;
  claims?: JsonObject;
}

export interface RpcHandlerContext {
  identity: RpcIdentity;
  clientId: string;
  sessionId: string;
  serverId: string;
  requestId: string;
  method: string;
  transport: TransportKind;
  signal: AbortSignal;
}

export type RpcHandler = (request: unknown, context: RpcHandlerContext) => unknown | Promise<unknown>;

export interface RpcHandlerOptions {
  timeoutMs?: number;
  idempotent?: boolean;
}

interface RegisteredHandler {
  handler: RpcHandler;
  options: RpcHandlerOptions;
}

export type RpcAuthorizer = (context: RpcHandlerContext) => void | Promise<void>;

export interface RpcServerOptions {
  idempotency: IdempotencyStore;
  defaultTimeoutMs: number;
  idempotencyTtlMs?: number;
  logger?: Logger;
  authorize?: RpcAuthorizer;
  now?: () => number;
}

const METHOD_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;

export class RpcServer {
  private readonly handlers = new Map<string, RegisteredHandler>();
  private readonly options: Required<Pick<RpcServerOptions, "defaultTimeoutMs" | "idempotencyTtlMs">> &
    RpcServerOptions;
  private readonly logger: Logger;

  constructor(options: RpcServerOptions) {
    this.options = { idempotencyTtlMs: 10 * 60_000, ...options };
    this.logger = options.logger ?? noopLogger;
  }

  register(method: string, handler: RpcHandler, options: RpcHandlerOptions = {}): void {
    if (!METHOD_PATTERN.test(method)) {
      throw new P2PLinkError(P2PLinkErrorCodes.INVALID_CONFIG, `Invalid RPC method: ${method}`);
    }
    if (this.handlers.has(method)) {
      throw new P2PLinkError(P2PLinkErrorCodes.INVALID_CONFIG, `Duplicate RPC handler: ${method}`);
    }
    this.handlers.set(method, { handler, options });
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  methods(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async handle(
    envelope: Envelope,
    base: Omit<RpcHandlerContext, "requestId" | "method" | "signal">,
  ): Promise<Envelope | null> {
    if (envelope.type !== "request") return null;
    const payload = envelope.payload;
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof (payload as { method?: unknown }).method !== "string"
    ) {
      return this.errorEnvelope(
        envelope,
        new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed request payload"),
      );
    }
    const method = (payload as { method: string }).method;
    const params = (payload as { params?: unknown }).params;
    const registered = this.handlers.get(method);
    if (!registered) {
      return this.errorEnvelope(
        envelope,
        new P2PLinkError(P2PLinkErrorCodes.METHOD_NOT_FOUND, `Unknown method: ${method}`),
      );
    }
    const key = `${base.clientId}\u0000${envelope.idem ?? envelope.id}`;
    const ttl = this.options.idempotencyTtlMs;
    let claim = await this.options.idempotency.claim(key, ttl);
    if (claim.status === "completed") {
      return this.outcomeEnvelope(envelope, claim.outcome);
    }
    if (claim.status === "in-progress") {
      const deadline = this.options.now ? this.options.now() + 2_000 : Date.now() + 2_000;
      while (this.options.now ? this.options.now() < deadline : Date.now() < deadline) {
        await sleep(25);
        claim = await this.options.idempotency.claim(key, ttl);
        if (claim.status === "completed") return this.outcomeEnvelope(envelope, claim.outcome);
        if (claim.status === "claimed") break;
      }
      return this.errorEnvelope(
        envelope,
        new P2PLinkError(
          P2PLinkErrorCodes.IDEMPOTENCY_IN_PROGRESS,
          "An identical request is still in progress",
          { retryable: true },
        ),
      );
    }

    const controller = new AbortController();
    const timeoutMs = registered.options.timeoutMs ?? this.options.defaultTimeoutMs;
    const context: RpcHandlerContext = {
      ...base,
      requestId: envelope.id,
      method,
      signal: controller.signal,
    };
    let settled = false;
    const finish = async (outcome: StoredRpcOutcome): Promise<void> => {
      if (settled) return;
      settled = true;
      await this.options.idempotency.complete(key, outcome, ttl).catch((error: unknown) => {
        this.logger.error("failed to persist idempotency outcome", {
          error: P2PLinkError.from(error).message,
        });
      });
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.options.authorize) await this.options.authorize(context);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new P2PLinkError(
              P2PLinkErrorCodes.OUTCOME_UNKNOWN,
              `Handler ${method} timed out; outcome unknown`,
              { outcomeUnknown: true, retryable: false },
            ),
          );
        }, timeoutMs);
        timer.unref?.();
      });
      const result = await Promise.race([
        Promise.resolve(registered.handler(params, context)),
        timeout,
      ]);
      clearTimeout(timer);
      const outcome: StoredRpcOutcome = { ok: true, payload: result ?? null };
      await finish(outcome);
      return this.outcomeEnvelope(envelope, outcome);
    } catch (error) {
      clearTimeout(timer);
      const normalized =
        error instanceof P2PLinkError
          ? error
          : new P2PLinkError(P2PLinkErrorCodes.HANDLER_ERROR, "Handler failed", { cause: error });
      if (!(error instanceof P2PLinkError)) {
        this.logger.error("handler error", {
          method,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const outcome: StoredRpcOutcome = { ok: false, error: normalized.toJSON() };
      if (normalized.outcomeUnknown) {
        await finish(outcome);
      } else if (normalized.code === P2PLinkErrorCodes.FORBIDDEN) {
        await this.options.idempotency.release(key);
      } else {
        await finish(outcome);
      }
      return this.errorEnvelope(envelope, normalized);
    }
  }

  private outcomeEnvelope(request: Envelope, outcome: StoredRpcOutcome): Envelope {
    if (outcome.ok) {
      return createEnvelope("response", request.sid, outcome.payload, { cid: request.id });
    }
    return createEnvelope("error", request.sid, outcome.error, { cid: request.id });
  }

  private errorEnvelope(request: Envelope, error: P2PLinkError): Envelope {
    return createEnvelope("error", request.sid, error.toJSON(), { cid: request.id });
  }
}
