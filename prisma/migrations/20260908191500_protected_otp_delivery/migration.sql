-- Encrypted-at-rest OTP delivery is available only to the bound stall (02 §8, 04 §§8,17).
ALTER TABLE "OtpChallenge" ADD COLUMN "otpCiphertext" TEXT;
UPDATE "OtpChallenge"
SET "otpCiphertext" = '',
    "invalidatedAt" = COALESCE("invalidatedAt", NOW()),
    "activeTicketKey" = NULL;
ALTER TABLE "OtpChallenge" ALTER COLUMN "otpCiphertext" SET NOT NULL;
