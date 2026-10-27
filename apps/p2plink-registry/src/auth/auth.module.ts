import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller.js";
import { AdminController } from "./admin.controller.js";
import { AuthService } from "./auth.service.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import { RolesGuard } from "./roles.guard.js";
import { config } from "../config.js";
import { BrokerModule } from "../broker/broker.module.js";

@Module({
  imports: [
    BrokerModule,
    JwtModule.register({
      secret: config.jwtSecret,
      signOptions: { expiresIn: config.accessTtlSeconds },
    }),
  ],
  controllers: [AuthController, AdminController],
  providers: [AuthService, JwtAuthGuard, RolesGuard],
  exports: [JwtModule, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
