import { Module } from "@nestjs/common";
import { BrokerModule } from "../broker/broker.module.js";
import { RegistryController } from "./registry.controller.js";
import { RegistrySignerService } from "./registry-signer.service.js";
import { REGISTRY_SIGNER } from "./registry-signer.interface.js";

@Module({
  imports: [BrokerModule],
  controllers: [RegistryController],
  providers: [
    RegistrySignerService,
    { provide: REGISTRY_SIGNER, useExisting: RegistrySignerService },
  ],
  exports: [RegistrySignerService, REGISTRY_SIGNER],
})
export class RegistryModule {}
