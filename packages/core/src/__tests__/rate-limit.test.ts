import { describe, expect, it } from "vitest";
import { TokenBucket } from "../rate-limit.js";

describe("TokenBucket", () => {
  it("limits and refills", () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: () => now });
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
    now = 1500;
    expect(bucket.tryRemove()).toBe(true);
  });
});
