-- Privileged, reasoned queue priority overrides (02 §6, 04 §5).
ALTER TABLE "Ticket" ADD COLUMN "queuePriorityOverrideAt" TIMESTAMP(3);
CREATE INDEX "Ticket_poolId_status_queuePriorityOverrideAt_createdAt_idx"
ON "Ticket"("poolId", "status", "queuePriorityOverrideAt", "createdAt");
