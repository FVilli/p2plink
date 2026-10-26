import { describe, expect, it } from "vitest";
import { randomBytes } from "@p2plink/core";
import { WebRtcTransport } from "../webrtc-transport.js";
import { createNodeWebRtcEngine } from "../node.js";

function waitForOpen(transport: WebRtcTransport, timeoutMs = 15_000): Promise<void> {
  if (transport.state === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timeout waiting for open (state ${transport.state})`));
    }, timeoutMs);
    const unsubscribe = transport.onStateChange((state) => {
      if (state === "open") {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      } else if (state === "failed" || state === "closed") {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error(`transport became ${state}`));
      }
    });
  });
}

describe("WebRtcTransport with node-datachannel", () => {
  it("negotiates, chunks large frames and stays bidirectional", async () => {
    const engine = createNodeWebRtcEngine();
    let server: WebRtcTransport;
    let client: WebRtcTransport;
    const errors: unknown[] = [];
    client = new WebRtcTransport({
      engine,
      role: "offerer",
      negotiationId: "neg-1",
      epoch: 0,
      iceServers: [],
      sendSignal: async (signal) => {
        try {
          await server.handleSignal(signal);
        } catch (error) {
          errors.push(error);
        }
      },
    });
    server = new WebRtcTransport({
      engine,
      role: "answerer",
      negotiationId: "neg-1",
      epoch: 0,
      iceServers: [],
      sendSignal: async (signal) => {
        try {
          await client.handleSignal(signal);
        } catch (error) {
          errors.push(error);
        }
      },
    });

    await client.start();
    await Promise.all([waitForOpen(client), waitForOpen(server)]);
    expect(client.state).toBe("open");
    expect(server.state).toBe("open");

    const large = randomBytes(100_000);
    const received = new Promise<Uint8Array>((resolve) => server.onData(resolve));
    await client.send(large);
    const inbound = await received;
    expect(inbound.length).toBe(large.length);
    expect(Buffer.from(inbound).equals(Buffer.from(large))).toBe(true);

    const reply = new Promise<Uint8Array>((resolve) => client.onData(resolve));
    await server.send(new Uint8Array([1, 2, 3, 4, 5]));
    expect(Array.from(await reply)).toEqual([1, 2, 3, 4, 5]);

    await client.close();
    await server.close();
    expect(client.state).toBe("closed");
    expect(server.state).toBe("closed");
    expect(errors).toEqual([]);
  }, 30_000);
});
