-- Sign-in identifier, separate from the database primary key and from email.
ALTER TABLE "User" ADD COLUMN "loginId" TEXT;

UPDATE "User" SET "loginId" = LOWER("email") WHERE "loginId" IS NULL;

ALTER TABLE "User" ALTER COLUMN "loginId" SET NOT NULL;
CREATE UNIQUE INDEX "User_loginId_key" ON "User"("loginId");
