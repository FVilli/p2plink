import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { ApiTags } from "@nestjs/swagger";

@ApiTags("revocations")
@Controller("v1/revocations")
export class RevocationsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list() {
    return this.prisma.revocation.findMany({
      where: { status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      select: {
        peer: { select: { peerId: true } },
        serial: true,
        reason: true,
        event: true,
        completedAt: true,
      },
    });
  }
}
