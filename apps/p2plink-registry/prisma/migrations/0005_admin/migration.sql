ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;
UPDATE "User" SET "isAdmin" = true WHERE lower("username") = 'fvilli@gmail.com';
