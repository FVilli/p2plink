import { Module } from "@nestjs/common";
import { BROKER_ADMIN } from "./broker-admin.interface.js";
import { MosquittoAdminService } from "./mosquitto-admin.service.js";

@Module({
  providers: [MosquittoAdminService, { provide: BROKER_ADMIN, useExisting: MosquittoAdminService }],
  exports: [BROKER_ADMIN],
})
export class BrokerModule {}
