import "reflect-metadata";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, "../../web/dist/browser");

const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.enableCors({
  origin: ["http://127.0.0.1:4200", "http://localhost:4200", "http://127.0.0.1:3000"],
  allowedHeaders: ["authorization", "content-type"],
});
app.enableShutdownHooks();
if (existsSync(webDist)) {
  app.useStaticAssets(webDist, { index: "index.html" });
  console.info(`[demo] serving Angular build from ${webDist}`);
} else {
  console.warn(`[demo] Angular build not found at ${webDist}; run the web build`);
}
const port = Number(process.env.PORT ?? 3000);
await app.listen(port, "127.0.0.1");
console.info(`[demo] NestJS listening on http://127.0.0.1:${port}`);
