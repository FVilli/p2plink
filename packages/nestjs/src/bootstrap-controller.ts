import { Body, Controller, Headers, HttpCode, HttpException, Ip, Post } from "@nestjs/common";
import type { P2PLinkServer } from "@p2plink/server";
import { Inject } from "@nestjs/common";
import { P2PLINK_SERVER } from "./tokens.js";

/**
 * Optional controller registered with `P2PLinkModule.forRoot({ httpBootstrap: true })`.
 * In production it must be exposed over HTTPS and protected by application auth.
 */
@Controller("p2plink/v1")
export class P2PLinkBootstrapController {
  constructor(@Inject(P2PLINK_SERVER) private readonly server: P2PLinkServer) {}

  @Post("bootstrap")
  @HttpCode(200)
  async bootstrap(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
    @Ip() ip?: string,
  ): Promise<unknown> {
    const result = await this.server.handleBootstrap({
      method: "POST",
      headers: { authorization },
      body,
      ...(ip === undefined ? {} : { ip }),
    });
    if (result.status !== 200) {
      throw new HttpException(result.body as string | Record<string, unknown>, result.status);
    }
    return result.body;
  }
}
