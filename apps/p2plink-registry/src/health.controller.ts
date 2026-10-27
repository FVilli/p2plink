import { Controller, Get, Inject } from "@nestjs/common";
import { BROKER_ADMIN, type BrokerAdmin } from "./broker/broker-admin.interface.js";

@Controller()
export class HealthController {
  constructor(@Inject(BROKER_ADMIN) private readonly broker: BrokerAdmin) {}

  @Get("health")
  health() {
    return { status: "ok" };
  }

  @Get("ready")
  ready() {
    return this.broker.isHealthy() ? { status: "ready" } : { status: "degraded", broker: false };
  }
}
