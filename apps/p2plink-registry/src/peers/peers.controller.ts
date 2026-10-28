/* eslint-disable @typescript-eslint/no-explicit-any, no-empty */
import { randomBytes, createHash } from "node:crypto";
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  UseGuards,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  HttpCode,
} from "@nestjs/common";
import {
  validatePublicJwk,
  normalizePublicJwk,
  verifySignature,
  publicKeyFingerprint,
} from "@p2plink/crypto";
import { config } from "../config.js";
import { CurrentUser, type CurrentUserValue } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { BROKER_ADMIN, type BrokerAdmin } from "../broker/broker-admin.interface.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { REGISTRY_SIGNER, type RegistrySigner } from "../registry/registry-signer.interface.js";

const canonical = (purpose: string, id: string, nonce: string) =>
  `p2plink-registry:${purpose}:${id}:${nonce}`;
const random = (size = 32) => randomBytes(size).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const jsonKey = (v: unknown) => v as JsonWebKey;

@Controller("v1/peers")
@UseGuards(JwtAuthGuard)
export class PeersController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BROKER_ADMIN) private readonly broker: BrokerAdmin,
    @Inject(REGISTRY_SIGNER) private readonly signer: RegistrySigner,
  ) {}

  @Post("challenge")
  async challenge(@Body() body: any, @CurrentUser() user: CurrentUserValue) {
    if (!["REGISTER", "CREDENTIALS"].includes(body?.purpose))
      throw new BadRequestException("Invalid purpose");
    let peer: any = null;
    let key: JsonWebKey | undefined;
    if (body.purpose === "REGISTER") {
      if (!body.publicKeyJwk) throw new BadRequestException("publicKeyJwk required");
      try {
        validatePublicJwk(body.publicKeyJwk);
        key = normalizePublicJwk(body.publicKeyJwk);
      } catch {
        throw new BadRequestException("Invalid public key");
      }
    } else {
      if (!body.peerId) throw new BadRequestException("peerId required");
      peer = await this.prisma.peer.findUnique({ where: { peerId: body.peerId } });
      if (!peer || (user.role !== "ADMIN" && peer.userId !== user.sub))
        throw new NotFoundException();
      if (peer.status !== "ACTIVE") throw new ConflictException("Peer is not active");
      if (body.publicKeyJwk) {
        try {
          if ((await publicKeyFingerprint(body.publicKeyJwk)) !== peer.fingerprint)
            throw new Error();
        } catch {
          throw new BadRequestException("Key does not match peer");
        }
      }
      key = jsonKey(peer.publicKeyJwk);
    }
    const nonce = random();
    const expiresAt = new Date(Date.now() + config.challengeTtlSeconds * 1000);
    const row = await this.prisma.peerChallenge.create({
      data: {
        userId: user.sub,
        nonce,
        nonceHash: hash(nonce),
        purpose: body.purpose,
        peerId: peer?.id,
        publicKeyJwk: key as any,
        expiresAt,
      },
    });
    return { challengeId: row.id, nonce, expiresAt };
  }

  @Post()
  async register(@Body() body: any, @CurrentUser() user: CurrentUserValue) {
    const challenge = await this.consume(body.challengeId, body.nonce, "REGISTER", user.sub);
    let publicKeyJwk: JsonWebKey;
    try {
      validatePublicJwk(body.publicKeyJwk);
      publicKeyJwk = normalizePublicJwk(body.publicKeyJwk);
    } catch {
      throw new BadRequestException("Invalid public key");
    }
    if (
      (await publicKeyFingerprint(publicKeyJwk)) !==
      (await publicKeyFingerprint(jsonKey(challenge.publicKeyJwk)))
    )
      throw new BadRequestException("Key mismatch");
    if (
      !(await verifySignature(
        publicKeyJwk,
        Buffer.from(canonical("register", challenge.id, body.nonce)),
        body.signature,
      ))
    )
      throw new ForbiddenException("Invalid proof");
    if (typeof body.name !== "string" || !body.name.trim())
      throw new BadRequestException("Invalid name");
    const fingerprint = await publicKeyFingerprint(publicKeyJwk);
    const duplicate = await this.prisma.peer.findFirst({
      where: { userId: user.sub, fingerprint, status: { not: "REVOKED" } },
    });
    if (duplicate)
      throw new ConflictException(
        "This key is already registered; request new credentials instead",
      );
    const peerId = `p_${random(18)}`;
    const serial = random(16);
    const issuedAt = new Date();
    const certExpiry = new Date(issuedAt.getTime() + config.certificateTtlDays * 86400000);
    const certificate = await this.signer.signPeerCertificate({
      peerId,
      userId: user.sub,
      publicKeyJwk,
      fingerprint,
      serial,
      issuedAt,
      expiresAt: certExpiry,
    });
    const password = random(36);
    const grantExpiry = new Date(Date.now() + config.mqttGrantTtlSeconds * 1000);
    try {
      await this.broker.createPeer({
        username: peerId,
        password,
        clientId: peerId,
        role: config.mqttPeerRole,
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `Broker unavailable: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
    try {
      const peer = await this.prisma.$transaction(async (tx) => {
        const created = await tx.peer.create({
          data: {
            peerId,
            userId: user.sub,
            name: body.name.trim(),
            publicKeyJwk: publicKeyJwk as any,
            fingerprint,
            certificate: certificate.token,
            certificateSerial: serial,
            certificateExpiresAt: certificate.expiresAt,
          },
        });
        await tx.brokerGrant.create({
          data: {
            peerId: created.id,
            mqttUsername: peerId,
            expiresAt: grantExpiry,
            status: "ACTIVE",
          },
        });
        return created;
      });
      return {
        peer,
        mqtt: { url: config.mqttPublicUrl, username: peerId, password, clientId: peerId },
        certificate: certificate.token,
      };
    } catch (error) {
      try {
        await this.broker.deletePeer(peerId);
      } catch {}
      if ((error as { code?: string }).code === "P2002")
        throw new ConflictException("This key is already registered");
      throw new ServiceUnavailableException("Peer provisioning failed");
    }
  }

  @Get()
  list(@CurrentUser() user: CurrentUserValue) {
    return this.prisma.peer.findMany({
      where: user.role === "ADMIN" ? {} : { userId: user.sub },
      select: {
        peerId: true,
        name: true,
        fingerprint: true,
        status: true,
        certificate: true,
        certificateSerial: true,
        certificateExpiresAt: true,
        createdAt: true,
      },
    });
  }

  @Get(":peerId")
  async get(@Param("peerId") id: string, @CurrentUser() user: CurrentUserValue) {
    const peer = await this.prisma.peer.findUnique({ where: { peerId: id } });
    if (!peer) throw new NotFoundException();
    this.owned(peer, user);
    return peer;
  }

  @Post(":peerId/credentials")
  async credentials(
    @Param("peerId") id: string,
    @Body() body: any,
    @CurrentUser() user: CurrentUserValue,
  ) {
    const peer = await this.prisma.peer.findUnique({ where: { peerId: id } });
    if (!peer) throw new NotFoundException();
    this.owned(peer, user);
    if (peer.status !== "ACTIVE") throw new ConflictException("Peer is not active");
    const requestedName =
      typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 64) : peer.name;
    const challenge = await this.consume(body.challengeId, body.nonce, "CREDENTIALS", user.sub);
    if (
      challenge.peerId !== peer.id ||
      !(await verifySignature(
        jsonKey(peer.publicKeyJwk),
        Buffer.from(canonical("credentials", challenge.id, body.nonce)),
        body.signature,
      ))
    )
      throw new ForbiddenException("Invalid proof");
    const password = random(36);
    const grantExpiry = new Date(Date.now() + config.mqttGrantTtlSeconds * 1000);
    await this.broker.rotatePeer({
      username: id,
      password,
      clientId: id,
      role: config.mqttPeerRole,
    });
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + config.certificateTtlDays * 86400000);
    const serial = random(16);
    const cert = await this.signer.signPeerCertificate({
      peerId: id,
      userId: peer.userId,
      publicKeyJwk: jsonKey(peer.publicKeyJwk),
      fingerprint: peer.fingerprint,
      serial,
      issuedAt,
      expiresAt,
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.peer.update({
        where: { id: peer.id },
        data: {
          name: requestedName,
          certificate: cert.token,
          certificateSerial: serial,
          certificateExpiresAt: cert.expiresAt,
        },
      });
      await tx.brokerGrant.update({
        where: { peerId: peer.id },
        data: { expiresAt: grantExpiry, status: "ACTIVE" },
      });
    });
    return {
      mqtt: { url: config.mqttPublicUrl, username: id, password, clientId: id },
      certificate: cert.token,
    };
  }

  @Post(":peerId/revoke")
  @HttpCode(200)
  async revoke(
    @Param("peerId") id: string,
    @Body() body: any,
    @CurrentUser() user: CurrentUserValue,
  ) {
    const peer = await this.prisma.peer.findUnique({ where: { peerId: id } });
    if (!peer) throw new NotFoundException();
    this.owned(peer, user);
    if (peer.status === "REVOKED") throw new ConflictException("Already revoked");
    await this.prisma.peer.update({ where: { id: peer.id }, data: { status: "REVOKED" } });
    const serial = peer.certificateSerial ?? "";
    const reason = typeof body?.reason === "string" ? body.reason : "owner requested";
    const revokedAt = new Date();
    const event = await this.signer.signRevocation({ peerId: id, serial, reason, revokedAt });
    const revocation = await this.prisma.revocation.create({
      data: { peerId: peer.id, serial, reason, event: event.event as any },
    });
    try {
      await this.broker.disablePeer(id);
      await this.broker.publishRevocation(event.event);
      await this.prisma.revocation.update({
        where: { id: revocation.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      return { status: "COMPLETED" };
    } catch {
      return { status: "PENDING" };
    }
  }

  private owned(peer: any, user: CurrentUserValue) {
    if (user.role !== "ADMIN" && peer.userId !== user.sub) throw new ForbiddenException();
  }
  private async consume(id: string, nonce: string, purpose: string, userId: string): Promise<any> {
    if (typeof id !== "string" || typeof nonce !== "string")
      throw new BadRequestException("Invalid challenge");
    const row = await this.prisma.peerChallenge.findUnique({ where: { id } });
    if (
      !row ||
      row.purpose !== purpose ||
      row.userId !== userId ||
      row.nonceHash !== hash(nonce) ||
      row.nonce !== nonce ||
      row.usedAt ||
      row.expiresAt <= new Date()
    )
      throw new ConflictException("Challenge expired or invalid");
    const updated = await this.prisma.peerChallenge.updateMany({
      where: { id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (!updated.count) throw new ConflictException("Challenge already used");
    return row;
  }
}
