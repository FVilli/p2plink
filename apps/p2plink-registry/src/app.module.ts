import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { BrokerModule } from "./broker/broker.module.js";
import { HealthController } from "./health.controller.js";
import { PeersModule } from "./peers/peers.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { RegistryModule } from "./registry/registry.module.js";

@Module({
  imports: [PrismaModule, BrokerModule, RegistryModule, AuthModule, PeersModule],
  controllers: [HealthController],
})
export class AppModule {}
