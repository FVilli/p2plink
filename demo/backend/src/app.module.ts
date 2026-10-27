import { Module } from "@nestjs/common";
import { MeshService } from "./mesh.service.js";
import { StatsController } from "./stats.controller.js";

@Module({ controllers: [StatsController], providers: [MeshService] })
export class AppModule {}
