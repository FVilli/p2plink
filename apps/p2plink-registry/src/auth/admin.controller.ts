import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { IsIn, IsString, MinLength } from "class-validator";
import { AuthService } from "./auth.service.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import { Roles, RolesGuard } from "./roles.guard.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { BROKER_ADMIN, type BrokerAdmin } from "../broker/broker-admin.interface.js";

class CreateUserDto {
  @IsString()
  @MinLength(2)
  username!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsIn(["USER", "ADMIN"])
  role: "USER" | "ADMIN" = "USER";
}

class StatusDto {
  @IsIn(["ACTIVE", "DISABLED"])
  status!: "ACTIVE" | "DISABLED";
}

@Controller("v1/admin")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
export class AdminController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    @Inject(BROKER_ADMIN) private readonly broker: BrokerAdmin,
  ) {}

  @Get("users")
  users() {
    return this.prisma.user.findMany({
      select: { id: true, username: true, role: true, status: true, createdAt: true },
      orderBy: { username: "asc" },
    });
  }

  @Post("users")
  async create(@Body() body: CreateUserDto) {
    try {
      const user = await this.auth.createUser(body.username, body.password, body.role);
      return { id: user.id, username: user.username, role: user.role, status: user.status };
    } catch (error) {
      throw new ConflictException(
        error instanceof Error && /unique|duplicate/i.test(error.message)
          ? "Username already exists"
          : "Could not create user",
      );
    }
  }

  @Patch("users/:id/status")
  async status(@Param("id") id: string, @Body() body: StatusDto) {
    const user = await this.auth.setUserStatus(id, body.status);
    if (body.status === "DISABLED") {
      const peers = await this.prisma.peer.findMany({
        where: { userId: id, status: "ACTIVE" },
        select: { peerId: true },
      });
      for (const peer of peers) {
        try {
          await this.broker.disablePeer(peer.peerId);
          await this.prisma.peer.update({
            where: { peerId: peer.peerId },
            data: { status: "DISABLED" },
          });
          await this.prisma.brokerGrant.updateMany({
            where: { peerId: peer.peerId },
            data: { status: "DISABLED" },
          });
        } catch {
          // The user is disabled locally; broker cleanup can be retried.
        }
      }
    }
    return { id: user.id, username: user.username, status: user.status };
  }
}
