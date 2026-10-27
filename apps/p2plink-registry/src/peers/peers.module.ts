import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { BrokerModule } from "../broker/broker.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { RegistryModule } from "../registry/registry.module.js";
import { PeersController } from "./peers.controller.js";
import { RevocationsController } from "./revocations.controller.js";

@Module({
  imports: [AuthModule, PrismaModule, BrokerModule, RegistryModule],
  controllers: [PeersController, RevocationsController],
})
export class PeersModule {}
