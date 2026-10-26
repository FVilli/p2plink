/** Sliding-window replay protection for a single key and direction. */
export class ReplayWindow {
  private readonly window: number;
  private highest = -1;
  private bitmap = 0n;
  private readonly mask: bigint;

  constructor(window = 1024) {
    if (!Number.isInteger(window) || window < 1 || window > 4096) {
      throw new RangeError("Replay window must be an integer between 1 and 4096");
    }
    this.window = window;
    this.mask = (1n << BigInt(window)) - 1n;
  }

  check(sequence: number): boolean {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return false;
    if (this.highest < 0) return true;
    if (sequence > this.highest) return true;
    const diff = this.highest - sequence;
    if (diff >= this.window) return false;
    return ((this.bitmap >> BigInt(diff)) & 1n) === 0n;
  }

  commit(sequence: number): void {
    if (this.highest < 0) {
      this.highest = sequence;
      this.bitmap = 1n;
      return;
    }
    if (sequence > this.highest) {
      const shift = BigInt(sequence - this.highest);
      this.bitmap = ((this.bitmap << shift) | 1n) & this.mask;
      this.highest = sequence;
      return;
    }
    const diff = BigInt(this.highest - sequence);
    if (diff < BigInt(this.window)) this.bitmap |= 1n << diff;
  }

  get highestSeen(): number {
    return this.highest;
  }
}
