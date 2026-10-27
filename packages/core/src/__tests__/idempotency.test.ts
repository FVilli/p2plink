import { describe, expect, it, vi } from "vitest";
import { MemoryIdempotencyStore } from "../idempotency.js";

describe("MemoryIdempotencyStore", () => {
  it("claims once and replays completion", async () => {
    const store = new MemoryIdempotencyStore();
    expect(await store.claim("k", 1000)).toEqual({ status: "claimed" });
    expect(await store.claim("k", 1000)).toEqual({ status: "in-progress" });
    await store.complete("k", { ok: true, payload: 42 }, 1000);
    expect(await store.claim("k", 1000)).toEqual({
      status: "completed",
      outcome: { ok: true, payload: 42 },
    });
  });

  it("releases in-progress and expires records", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const store = new MemoryIdempotencyStore();
    await store.claim("k", 100);
    await store.release("k");
    expect(await store.claim("k", 100)).toEqual({ status: "claimed" });
    await store.complete(
      "k",
      { ok: false, error: { code: "X", message: "x", retryable: false, outcomeUnknown: false } },
      100,
    );
    vi.setSystemTime(new Date(200));
    expect(await store.claim("k", 100)).toEqual({ status: "claimed" });
    vi.useRealTimers();
  });
});
