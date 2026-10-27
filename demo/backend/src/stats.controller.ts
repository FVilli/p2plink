import { Controller, Get } from "@nestjs/common";
import { MeshService } from "./mesh.service.js";

@Controller()
export class StatsController {
  constructor(private readonly mesh: MeshService) {}

  @Get("health")
  health() {
    return this.mesh.getSnapshot();
  }

  @Get("stats")
  stats() {
    return this.mesh.getSnapshot();
  }
}
