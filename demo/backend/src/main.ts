import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3100), "127.0.0.1");
}

void bootstrap();
