import { Inject, Injectable } from "@nestjs/common";
import { P2PHandler, P2PRequestContext } from "@p2plink/nestjs";
import { P2PLINK_SERVER } from "@p2plink/nestjs";
import type { P2PLinkServer } from "@p2plink/server";
import { randomToken } from "@p2plink/core";

interface Item {
  id: string;
  name: string;
}

@Injectable()
export class DataHandlers {
  private readonly items: Item[] = [
    { id: "1", name: "Elemento dal backend NestJS" },
    { id: "2", name: "Secondo elemento" },
  ];

  constructor(@Inject(P2PLINK_SERVER) private readonly server: P2PLinkServer) {}

  @P2PHandler("data.list")
  async list(_request: unknown, context: P2PRequestContext) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      items: this.items,
      subject: context.identity.subject,
      transport: context.transport,
      sessionId: context.sessionId,
    };
  }

  @P2PHandler("data.add", { idempotent: true, timeoutMs: 5_000 })
  async add(request: { name: string }, context: P2PRequestContext) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    const item: Item = { id: randomToken(4), name: String(request.name).slice(0, 120) };
    this.items.push(item);
    await this.server.emitTo(context.clientId, "data.updated", { items: this.items });
    return item;
  }

  @P2PHandler("system.info")
  info(_request: unknown, context: P2PRequestContext) {
    return {
      subject: context.identity.subject,
      clientId: context.clientId,
      sessionId: context.sessionId,
      transport: context.transport,
      claims: context.identity.claims ?? null,
    };
  }
}
