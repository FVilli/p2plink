/** Token bucket used for per-session and global abuse protection. */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(options: {
    capacity: number;
    refillPerSecond: number;
    now?: () => number;
    initialTokens?: number;
  }) {
    this.capacity = Math.max(1, options.capacity);
    this.refillPerMs = Math.max(0, options.refillPerSecond) / 1000;
    this.now = options.now ?? (() => Date.now());
    this.lastRefill = this.now();
    this.tokens = Math.min(this.capacity, options.initialTokens ?? this.capacity);
  }

  tryRemove(count = 1): boolean {
    this.refill();
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  private refill(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefill);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }
}
