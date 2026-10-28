ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "verificationTokenHash" TEXT;
ALTER TABLE "User" ADD COLUMN "verificationTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "passwordResetTokenHash" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordResetTokenExpiresAt" TIMESTAMP(3);
UPDATE "User" SET "emailVerifiedAt" = NOW() WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "User_verificationTokenHash_key" ON "User"("verificationTokenHash");
CREATE UNIQUE INDEX "User_passwordResetTokenHash_key" ON "User"("passwordResetTokenHash");
