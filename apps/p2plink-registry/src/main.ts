import "dotenv/config";
import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { config } from "./config.js";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const app = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  new FastifyAdapter({ logger: { level: "info" } }),
);
app.useGlobalPipes(
  new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
);
app.enableCors({ origin: config.corsOrigin.split(",").map((origin) => origin.trim()) });
app.enableShutdownHooks();
const document = SwaggerModule.createDocument(
  app,
  new DocumentBuilder().setTitle("P2PLink Registry API").setVersion("1.0").addBearerAuth().build(),
);
SwaggerModule.setup("v1/swagger", app, document);
const fastify = app.getHttpAdapter().getInstance();
fastify.get("/swagger", (_req: unknown, reply: { redirect: (url: string) => void }) =>
  reply.redirect("/v1/swagger"),
);
const localAdminDir = join(process.cwd(), "admin/dist/browser");
const runtimeAdminDir = join(fileURLToPath(new URL(".", import.meta.url)), "admin");
const adminDir = existsSync(localAdminDir) ? localAdminDir : runtimeAdminDir;
await fastify.register(fastifyStatic, { root: adminDir, prefix: "/admin/", decorateReply: false });
fastify.get("/admin", (_req: unknown, reply: { redirect: (url: string) => void }) =>
  reply.redirect("/admin/"),
);
await app.listen(config.port, "0.0.0.0");
