-- Enforce one active OTP challenge per ticket (02 §8, 04 §8).
ALTER TABLE "OtpChallenge" ADD COLUMN "activeTicketKey" TEXT;
UPDATE "OtpChallenge"
SET "activeTicketKey" = "ticketId"
WHERE "invalidatedAt" IS NULL AND "verifiedAt" IS NULL;
CREATE UNIQUE INDEX "OtpChallenge_activeTicketKey_key" ON "OtpChallenge"("activeTicketKey");
