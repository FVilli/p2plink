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
import { AdminGuard } from "./admin.guard.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { BROKER_ADMIN, type BrokerAdmin } from "../broker/broker-admin.interface.js";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { PresenceService } from "../presence/presence.service.js";

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

@ApiTags("admin")
@ApiBearerAuth()
@Controller("v1/admin")
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    @Inject(BROKER_ADMIN) private readonly broker: BrokerAdmin,
    private readonly presence: PresenceService,
  ) {}

  @ApiOperation({ summary: "Get registry administration statistics" })
  @Get("stats")
  async stats() {
    const [users, peers, revoked, grants] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.peer.count(),
      this.prisma.peer.count({ where: { status: "REVOKED" } }),
      this.prisma.brokerGrant.count(),
    ]);
    const online = this.presence.count();
    return {
      users,
      online,
      presence: this.presence.list(),
      peers,
      revoked,
      grants,
      brokerHealthy: this.broker.isHealthy(),
      traffic: {
        measured: "live MQTT presence; MQTT byte traffic is not exposed",
        presence: online,
      },
    };
  }

  @ApiOperation({ summary: "List registry peers" })
  @Get("peers")
  peers() {
    return this.prisma.peer.findMany({
      include: { user: { select: { username: true } }, grant: true },
      orderBy: { createdAt: "desc" },
    });
  }

  @ApiOperation({ summary: "Revoke a peer" })
  @Patch("peers/:id/revoke")
  async revoke(@Param("id") id: string) {
    const peer = await this.prisma.peer.findFirst({ where: { OR: [{ id }, { peerId: id }] } });
    if (!peer) throw new ConflictException("Peer not found");
    await this.broker.disablePeer(peer.peerId);
    await this.prisma.peer.update({ where: { id: peer.id }, data: { status: "REVOKED" } });
    await this.prisma.brokerGrant.updateMany({
      where: { peerId: peer.id },
      data: { status: "REVOKED" },
    });
    return { ok: true };
  }

  @ApiOperation({ summary: "List registry users" })
  @Get("users")
  users() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        createdAt: true,
      },
      orderBy: { username: "asc" },
    });
  }

  @ApiOperation({ summary: "Create a registry user" })
  @Post("users")
  async create(@Body() body: CreateUserDto) {
    try {
      const user = await this.auth.createUser(body.username, body.password, body.role);
      return {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
      };
    } catch (error) {
      throw new ConflictException(
        error instanceof Error && /unique|duplicate/i.test(error.message)
          ? "Username already exists"
          : "Could not create user",
      );
    }
  }

  @ApiOperation({ summary: "Update a user status" })
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
