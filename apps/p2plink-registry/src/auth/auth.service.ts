import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../prisma/prisma.service.js";
import { config } from "../config.js";
import * as argon2 from "argon2";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}
  async login(username: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { username: username.trim().toLowerCase() },
    });
    if (!user || user.status !== "ACTIVE" || !(await argon2.verify(user.passwordHash, password)))
      throw new UnauthorizedException("Invalid credentials");
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role });
    const refreshToken = randomBytes(48).toString("base64url");
    await this.prisma.session.create({
      data: {
        tokenHash: hash(refreshToken),
        userId: user.id,
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() + config.refreshTtlDays * 86400000),
      },
    });
    return { accessToken, refreshToken };
  }
  async refresh(token: string) {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hash(token) },
      include: { user: true },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.user.status !== "ACTIVE"
    )
      throw new UnauthorizedException("Invalid refresh token");
    const next = randomBytes(48).toString("base64url");
    await this.prisma.$transaction(async (tx) => {
      await tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      await tx.session.create({
        data: {
          tokenHash: hash(next),
          userId: session.userId,
          familyId: session.familyId,
          expiresAt: new Date(Date.now() + config.refreshTtlDays * 86400000),
        },
      });
    });
    return {
      accessToken: await this.jwt.signAsync({ sub: session.userId, role: session.user.role }),
      refreshToken: next,
    };
  }
  async logout(token: string) {
    await this.prisma.session.updateMany({
      where: { tokenHash: hash(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  async createUser(username: string, password: string, role: "USER" | "ADMIN" = "USER") {
    const normalized = username.trim().toLowerCase();
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    return this.prisma.user.create({ data: { username: normalized, passwordHash, role } });
  }

  async setUserStatus(id: string, status: "ACTIVE" | "DISABLED") {
    const user = await this.prisma.user.update({ where: { id }, data: { status } });
    if (status === "DISABLED")
      await this.prisma.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    return user;
  }
}
