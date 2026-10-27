import { Body, Controller, Get, Inject, Post } from "@nestjs/common";
import { P2PLINK_SERVER } from "@p2plink/nestjs";
import type { P2PLinkServer } from "@p2plink/server";

@Controller("debug")
export class DebugController {
  constructor(@Inject(P2PLINK_SERVER) private readonly server: P2PLinkServer) {}

  @Post("drop-p2p")
  async dropP2P(): Promise<{ dropped: boolean }> {
    return { dropped: await this.server.dropP2P("client-demo") };
  }

  @Post("emit")
  async emit(@Body() body: { event?: string; data?: unknown }) {
    const delivered = await this.server.emitTo(
      "client-demo",
      body.event ?? "demo.event",
      body.data ?? {},
    );
    return { delivered };
  }

  @Get("info")
  info() {
    return { sessions: this.server.getSessionInfo() };
  }
}
