ALTER TABLE "OutboxEvent"
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "deadLetteredAt" TIMESTAMP(3);

CREATE INDEX "OutboxEvent_processedAt_deadLetteredAt_nextAttemptAt_createdAt_idx"
  ON "OutboxEvent"("processedAt", "deadLetteredAt", "nextAttemptAt", "createdAt");
