import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { MailService } from "../mail/mail.service.js";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../prisma/prisma.service.js";
import { config } from "../config.js";
import { Inject } from "@nestjs/common";
import { BROKER_ADMIN, type BrokerAdmin } from "../broker/broker-admin.interface.js";
import * as argon2 from "argon2";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private maskEmail(email: string): string {
    const [local, domain] = email.split("@");
    return `${local?.slice(0, 1) ?? "*"}***@${
      domain
        ?.split(".")
        .map((part) => `${part.slice(0, 1)}***`)
        .join(".") ?? "***"
    }`;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    @Inject(BROKER_ADMIN) private readonly broker: BrokerAdmin,
  ) {}
  async login(username: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { username: username.trim().toLowerCase() },
    });
    if (
      !user ||
      user.status !== "ACTIVE" ||
      !user.emailVerifiedAt ||
      !(await argon2.verify(user.passwordHash, password))
    )
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
  async logout(token: string, peerId?: string) {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hash(token) },
      select: { userId: true },
    });
    if (session && peerId) {
      const peer = await this.prisma.peer.findFirst({
        where: { peerId, userId: session.userId },
        select: { peerId: true },
      });
      if (peer) {
        try {
          await this.broker.deletePeer(peer.peerId);
        } catch {
          // Local logout must still complete if the broker is unavailable.
        }
        await this.prisma.brokerGrant.updateMany({
          where: { mqttUsername: peer.peerId },
          data: { status: "DISABLED" },
        });
      }
    }
    await this.prisma.session.updateMany({
      where: { tokenHash: hash(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  private async issueToken(userId: string, kind: "verification" | "reset") {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(
      Date.now() +
        (kind === "verification" ? config.emailTokenTtlSeconds : config.passwordResetTtlSeconds) *
          1000,
    );
    if (kind === "verification") {
      await this.prisma.user.update({
        where: { id: userId },
        data: { verificationTokenHash: hash(token), verificationTokenExpiresAt: expires },
      });
      return token;
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordResetTokenHash: hash(token), passwordResetTokenExpiresAt: expires },
    });
    return token;
  }
  async register(email: string, password: string) {
    const normalized = email.trim().toLowerCase();
    let user = await this.prisma.user.findUnique({ where: { username: normalized } });
    if (!user) {
      const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
      user = await this.prisma.user.create({
        data: { username: normalized, passwordHash, role: "USER", status: "PENDING" },
      });
    }
    if (user.status === "PENDING") {
      const token = await this.issueToken(user.id, "verification");
      await this.mail.sendVerification(normalized, token);
      this.logger.log(`Verification email queued for ${this.maskEmail(normalized)}`);
    } else if (user.status === "ACTIVE") {
      this.logger.log(
        `Registration email skipped for ACTIVE account ${this.maskEmail(normalized)}`,
      );
    }
    return { ok: true };
  }
  async resendVerification(email: string) {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { username: normalized } });
    if (user?.status === "PENDING") {
      const token = await this.issueToken(user.id, "verification");
      await this.mail.sendVerification(normalized, token);
      this.logger.log(`Verification email queued for ${this.maskEmail(normalized)}`);
    } else if (user?.status === "ACTIVE") {
      this.logger.log(
        `Verification email skipped for ACTIVE account ${this.maskEmail(normalized)}`,
      );
    }
    return { ok: true };
  }
  async verifyEmail(email: string, token: string) {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { username: normalized } });
    const now = new Date();
    const result =
      user &&
      (await this.prisma.user.updateMany({
        where: {
          id: user.id,
          status: "PENDING",
          verificationTokenHash: hash(token),
          verificationTokenExpiresAt: { gt: now },
        },
        data: {
          status: "ACTIVE",
          emailVerifiedAt: now,
          verificationTokenHash: null,
          verificationTokenExpiresAt: null,
        },
      }));
    if (!result?.count) throw new UnauthorizedException("Invalid or expired token");
    const activeUser = await this.prisma.user.findUniqueOrThrow({ where: { id: user!.id } });
    return this.createSessionTokens(activeUser);
  }
  private async createSessionTokens(user: { id: string; role: string }) {
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
  async forgotPassword(email: string) {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { username: normalized } });
    if (user?.status === "ACTIVE" && user.emailVerifiedAt) {
      const token = await this.issueToken(user.id, "reset");
      await this.mail.sendPasswordReset(normalized, token);
      this.logger.log(`Password reset email queued for ${this.maskEmail(normalized)}`);
    } else if (user?.status === "ACTIVE") {
      this.logger.log(
        `Password reset email skipped for ACTIVE account ${this.maskEmail(normalized)}`,
      );
    }
    return { ok: true };
  }
  async resetPassword(email: string, token: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({
      where: { username: email.trim().toLowerCase() },
    });
    const result =
      user &&
      (await this.prisma.user.updateMany({
        where: {
          id: user.id,
          status: "ACTIVE",
          passwordResetTokenHash: hash(token),
          passwordResetTokenExpiresAt: { gt: new Date() },
        },
        data: {
          passwordHash: await argon2.hash(newPassword, { type: argon2.argon2id }),
          passwordResetTokenHash: null,
          passwordResetTokenExpiresAt: null,
        },
      }));
    if (!result?.count) throw new UnauthorizedException("Invalid or expired token");
    await this.prisma.session.updateMany({
      where: { userId: user!.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  async createUser(username: string, password: string, role: "USER" | "ADMIN" = "USER") {
    const normalized = username.trim().toLowerCase();
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    return this.prisma.user.create({
      data: {
        username: normalized,
        passwordHash,
        role,
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
    });
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
