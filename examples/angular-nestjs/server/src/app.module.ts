import { Module } from "@nestjs/common";
import { P2PLinkModule } from "@p2plink/nestjs";
import { loadP2PLinkOptions } from "./p2plink.config.js";
import { DataHandlers } from "./handlers.js";
import { DebugController } from "./debug.controller.js";

@Module({
  imports: [
    P2PLinkModule.forRootAsync({
      useFactory: loadP2PLinkOptions,
      httpBootstrap: true,
    }),
  ],
  controllers: [DebugController],
  providers: [DataHandlers],
})
export class AppModule {}
