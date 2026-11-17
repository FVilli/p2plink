import { randomToken, type Envelope } from "@p2plink/core";

export const ROUTE_TTL_MS = 10_000;
export const ROUTE_MAX_BYTES = 100_000;
const PROBE_MS = 250;
const MAX_CANDIDATES = 8;
const MAX_PENDING = 128;
const TOPIC = "demo.ping-route";

interface RouteMetadata {
  origin: string;
  destination: string;
  relay: string;
  hops: 1;
  expiresAt: number;
}
interface RoutedFrame extends RouteMetadata {
  kind: "forward" | "deliver";
  frame: string;
}

/** Internal demo-only seam; not exported from the mesh package entrypoint. */
export interface PingRoutePair {
  peerId: string;
  isDirectP2P(): boolean;
  sendRouteEvent(payload: unknown): Promise<void>;
  sealRoutedPing(envelope: Envelope): Promise<string>;
  openRoutedPing(frame: string): Promise<Envelope>;
  answerRoutedPing(envelope: Envelope): Promise<Envelope>;
}

export function validRoute(value: unknown, now = Date.now()): value is RoutedFrame {
  if (!value || typeof value !== "object") return false;
  const r = value as RoutedFrame;
  return (
    [r.origin, r.destination, r.relay].every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 128,
    ) &&
    new Set([r.origin, r.destination, r.relay]).size === 3 &&
    r.hops === 1 &&
    Number.isFinite(r.expiresAt) &&
    r.expiresAt > now &&
    r.expiresAt <= now + ROUTE_TTL_MS &&
    (r.kind === "forward" || r.kind === "deliver") &&
    typeof r.frame === "string" &&
    r.frame.length <= Math.ceil((ROUTE_MAX_BYTES * 4) / 3) &&
    /^[A-Za-z0-9_-]+$/u.test(r.frame)
  );
}

/** One relay only. A send/forward acknowledgement is never a ping success. */
export class PingRouter {
  private readonly probes = new Map<
    string,
    {
      peer: string;
      destination: string;
      resolve: (ready: boolean) => void;
    }
  >();
  private readonly pending = new Map<
    string,
    {
      route: RouteMetadata;
      resolve: (pong: Envelope) => void;
    }
  >();
  private readonly responses = new Map<
    string,
    {
      expiresAt: number;
      request: string;
      response: Promise<Envelope>;
    }
  >();
  private readonly knownRoutes = new Map<string, { relay: string; expiresAt: number }>();

  constructor(
    private readonly self: string,
    private readonly pairs: () => Iterable<PingRoutePair>,
  ) {}

  private pair(id: string): PingRoutePair | undefined {
    return [...this.pairs()].find((pair) => pair.peerId === id);
  }

  hasCandidates(destination: string): boolean {
    return [...this.pairs()].some((p) => p.peerId !== destination && p.isDirectP2P());
  }

  hasRoute(destination: string): boolean {
    const route = this.knownRoutes.get(destination);
    return Boolean(route && route.expiresAt > Date.now() && this.pair(route.relay)?.isDirectP2P());
  }

  async findRelay(destination: string): Promise<string | null> {
    const candidates = [...this.pairs()].filter((p) => p.peerId !== destination && p.isDirectP2P());
    if (candidates.length > MAX_CANDIDATES) throw new Error("OUTCOME_UNKNOWN: route fanout limit");
    let ambiguous = false;
    const results = await Promise.all(
      candidates.map(async (pair) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const id = randomToken(12);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const ready = await new Promise<boolean>((resolve, reject) => {
              this.probes.set(id, { peer: pair.peerId, destination, resolve });
              timer = setTimeout(() => reject(new Error("probe timeout")), PROBE_MS);
              void pair
                .sendRouteEvent({ topic: TOPIC, data: { kind: "probe", id, destination } })
                .catch(reject);
            });
            return ready ? pair.peerId : null;
          } catch {
            if (attempt === 1) ambiguous = true;
          } finally {
            if (timer) clearTimeout(timer);
            this.probes.delete(id);
          }
        }
        return null;
      }),
    );
    const relay = results.find((id) => id !== null) ?? null;
    if (relay) this.knownRoutes.set(destination, { relay, expiresAt: Date.now() + ROUTE_TTL_MS });
    else if (ambiguous) throw new Error("OUTCOME_UNKNOWN: route probe timeout");
    return relay;
  }

  async ping(
    pair: PingRoutePair,
    relay: string,
    envelope: Envelope,
    timeoutMs: number,
  ): Promise<Envelope> {
    if (this.pending.size >= MAX_PENDING) throw new Error("route pending limit");
    const ttl = Math.min(timeoutMs, ROUTE_TTL_MS);
    const route: RouteMetadata = {
      origin: this.self,
      destination: pair.peerId,
      relay,
      hops: 1,
      expiresAt: Date.now() + ttl,
    };
    const inner = { ...envelope, payload: { ...(envelope.payload as object), route } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const send = async () => {
      // Share AB's MQTT cipher with its manager: fresh sequence for each retry,
      // never replay cached ciphertext (also used by concurrent MQTT heartbeats).
      const frame = await pair.sealRoutedPing(inner);
      await this.send(relay, { ...route, kind: "forward", frame });
    };
    try {
      return await new Promise<Envelope>((resolve, reject) => {
        this.pending.set(envelope.id, { route, resolve });
        timer = setTimeout(() => reject(new Error("OUTCOME_UNKNOWN: routed ping timeout")), ttl);
        // A failed send may already have reached B. Retry only P2P, same ID.
        void send().catch(() => undefined);
        retry = setTimeout(() => {
          void send().catch(() => undefined);
        }, ttl / 2);
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (retry) clearTimeout(retry);
      this.pending.delete(envelope.id);
    }
  }

  private async send(peer: string, data: RoutedFrame): Promise<void> {
    const pair = this.pair(peer);
    if (!pair?.isDirectP2P()) throw new Error("route hop unavailable");
    await pair.sendRouteEvent({ topic: TOPIC, data });
  }

  async receive(from: string, payload: unknown): Promise<void> {
    const event = payload as { topic?: unknown; data?: Record<string, unknown> } | null;
    if (event?.topic !== TOPIC || !event.data || !this.pair(from)?.isDirectP2P()) return;
    const data = event.data;
    if (data.kind === "probe") {
      if (
        typeof data.id !== "string" ||
        data.id.length > 128 ||
        typeof data.destination !== "string" ||
        data.destination === from ||
        data.destination === this.self
      )
        return;
      await this.pair(from)!.sendRouteEvent({
        topic: TOPIC,
        data: {
          kind: "offer",
          id: data.id,
          destination: data.destination,
          ready: this.pair(data.destination)?.isDirectP2P() === true,
        },
      });
      return;
    }
    if (data.kind === "offer") {
      if (typeof data.id !== "string" || typeof data.ready !== "boolean") return;
      const probe = this.probes.get(data.id);
      if (probe?.peer === from && probe.destination === data.destination) probe.resolve(data.ready);
      return;
    }
    if (!validRoute(data)) return;
    if (data.kind === "forward") {
      if (data.origin !== from || data.relay !== this.self) return;
      // C never opens the inner AB frame, and never falls back on either hop.
      await this.send(data.destination, { ...data, kind: "deliver" });
      return;
    }
    if (data.relay !== from || data.destination !== this.self) return;
    const pair = this.pair(data.origin);
    if (!pair) return;
    const inner = await pair.openRoutedPing(data.frame);
    const route = (inner.payload as { route?: RouteMetadata } | null)?.route;
    if (
      !route ||
      route.origin !== data.origin ||
      route.destination !== data.destination ||
      route.relay !== data.relay ||
      route.hops !== 1 ||
      route.expiresAt !== data.expiresAt
    )
      return;
    if (inner.type === "response") {
      const pending = inner.cid ? this.pending.get(inner.cid) : undefined;
      if (
        pending &&
        pending.route.destination === data.origin &&
        pending.route.relay === from &&
        pending.route.expiresAt === data.expiresAt
      )
        pending.resolve(inner);
      return;
    }
    if (inner.type !== "request") return;
    const requestPayload = inner.payload as { method?: unknown };
    if (requestPayload.method !== "demo.ping") return;
    for (const [key, value] of this.responses) {
      if (value.expiresAt <= Date.now()) this.responses.delete(key);
    }
    const key = `${inner.sid}:${data.origin}:${inner.id}`;
    const request = JSON.stringify(inner);
    let cached = this.responses.get(key);
    if (cached && cached.request !== request) return;
    if (!cached) {
      if (this.responses.size >= MAX_PENDING) return;
      cached = { expiresAt: data.expiresAt, request, response: pair.answerRoutedPing(inner) };
      this.responses.set(key, cached);
    }
    const pong = await cached.response;
    if (data.expiresAt <= Date.now()) return;
    const back: RouteMetadata = { ...route, origin: this.self, destination: data.origin };
    const frame = await pair.sealRoutedPing({
      ...pong,
      payload: { ...(pong.payload as object), route: back },
    });
    await this.send(from, { ...back, kind: "forward", frame });
  }
}
