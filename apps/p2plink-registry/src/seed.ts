import "dotenv/config";
import argon2 from "argon2";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function seedUser(
  username: string,
  password: string,
  role: "USER" | "ADMIN",
  isAdmin = false,
): Promise<void> {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await prisma.user.upsert({
    where: { username: username.toLowerCase() },
    create: {
      username: username.toLowerCase(),
      passwordHash,
      role,
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      isAdmin,
    },
    update: { status: "ACTIVE", emailVerifiedAt: new Date(), isAdmin },
  });
}

async function main(): Promise<void> {
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword) throw new Error("SEED_ADMIN_PASSWORD is required");
  await seedUser(process.env.SEED_ADMIN_USERNAME ?? "admin", adminPassword, "ADMIN", true);
  const demoPassword = process.env.SEED_DEMO_PASSWORD;
  if (demoPassword) await seedUser(process.env.SEED_DEMO_USERNAME ?? "demo", demoPassword, "USER");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
