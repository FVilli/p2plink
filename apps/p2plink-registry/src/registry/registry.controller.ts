import { Controller, Get, Inject } from "@nestjs/common";
import { config } from "../config.js";
import { BROKER_ADMIN, type BrokerAdmin } from "../broker/broker-admin.interface.js";
import { RegistrySignerService } from "./registry-signer.service.js";
import { ApiTags } from "@nestjs/swagger";

@ApiTags("registry")
@Controller("v1/registry")
export class RegistryController {
  constructor(
    private readonly signer: RegistrySignerService,
    @Inject(BROKER_ADMIN) private readonly broker: BrokerAdmin,
  ) {}
  @Get("keys") keys() {
    return { keys: [this.signer.publicJwk()] };
  }
  @Get("health") health() {
    return { status: "ok", issuer: config.registryPublicUrl, broker: this.broker.isHealthy() };
  }
}
