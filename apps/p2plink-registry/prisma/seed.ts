import "dotenv/config";
import argon2 from "argon2";
import { PrismaClient, UserRole } from "@prisma/client";

const prisma = new PrismaClient();

async function seedUser(username: string, password: string, role: UserRole) {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await prisma.user.upsert({
    where: { username },
    create: {
      username,
      passwordHash,
      role,
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
    update: { role, status: "ACTIVE", emailVerifiedAt: new Date() },
  });
}

async function main() {
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword) throw new Error("SEED_ADMIN_PASSWORD is required");
  const adminUsername = process.env.SEED_ADMIN_USERNAME ?? "admin";
  await seedUser(adminUsername, adminPassword, UserRole.ADMIN);
  await prisma.user.updateMany({
    where: { username: "fvilli@gmail.com" },
    data: { role: UserRole.ADMIN },
  });

  const demoPassword = process.env.SEED_DEMO_PASSWORD;
  if (demoPassword)
    await seedUser(process.env.SEED_DEMO_USERNAME ?? "demo", demoPassword, UserRole.USER);
}

main().finally(() => prisma.$disconnect());
