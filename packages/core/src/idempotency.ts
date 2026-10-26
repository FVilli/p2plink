import type { SerializedError } from "./types.js";

export type StoredRpcOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; error: SerializedError };

export type IdempotencyClaim =
  | { status: "claimed" }
  | { status: "in-progress" }
  | { status: "completed"; outcome: StoredRpcOutcome };

/**
 * Server-side deduplication contract. Implementations must make `claim`
 * atomic. Durable exactly-once effects additionally require the application to
 * commit this record in the same transaction as its own state changes.
 */
export interface IdempotencyStore {
  claim(key: string, ttlMs: number): Promise<IdempotencyClaim>;
  complete(key: string, outcome: StoredRpcOutcome, ttlMs: number): Promise<void>;
  release(key: string): Promise<void>;
}

interface MemoryRecord {
  state: "in-progress" | "completed";
  expiresAt: number;
  outcome?: StoredRpcOutcome;
}

/** Bounded in-memory store for tests and non-critical single-process servers. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  async claim(key: string, ttlMs: number): Promise<IdempotencyClaim> {
    const now = Date.now();
    const existing = this.records.get(key);
    if (existing && existing.expiresAt <= now) {
      this.records.delete(key);
    } else if (existing) {
      if (existing.state === "in-progress") return { status: "in-progress" };
      return { status: "completed", outcome: existing.outcome as StoredRpcOutcome };
    }
    this.evictIfNeeded(now);
    this.records.set(key, { state: "in-progress", expiresAt: now + ttlMs });
    return { status: "claimed" };
  }

  async complete(key: string, outcome: StoredRpcOutcome, ttlMs: number): Promise<void> {
    const existing = this.records.get(key);
    if (existing && existing.state === "completed") return;
    this.records.set(key, {
      state: "completed",
      expiresAt: Date.now() + ttlMs,
      outcome,
    });
  }

  async release(key: string): Promise<void> {
    const existing = this.records.get(key);
    if (existing?.state === "in-progress") this.records.delete(key);
  }

  /** Test/observability helper. */
  size(): number {
    return this.records.size;
  }

  private evictIfNeeded(now: number): void {
    if (this.records.size < this.maxEntries) return;
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now || record.state === "completed") {
        this.records.delete(key);
        if (this.records.size < this.maxEntries) return;
      }
    }
    while (this.records.size >= this.maxEntries) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) return;
      this.records.delete(oldest);
    }
  }
}
