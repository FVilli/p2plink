import type { IncomingMessage, ServerResponse } from "node:http";
import type { P2PLinkServer } from "./server.js";

const MAX_BOOTSTRAP_BODY = 64 * 1024;

/** Minimal Node adapter for the framework-agnostic bootstrap handler. */
export async function handleNodeBootstrapRequest(
  server: P2PLinkServer,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.length;
      if (size > MAX_BOOTSTRAP_BODY) {
        response.writeHead(413, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }
      chunks.push(buffer);
    }
    let body: unknown = null;
    if (chunks.length > 0) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Malformed JSON" }));
        return;
      }
    }
    const result = await server.handleBootstrap({
      method: request.method ?? "GET",
      headers: request.headers,
      body,
      ...(request.socket.remoteAddress === undefined ? {} : { ip: request.socket.remoteAddress }),
    });
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  } catch {
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Internal error" }));
  }
}
