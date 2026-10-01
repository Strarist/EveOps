-- Forward migration after 20260929160000_push_subscriptions.
-- ServicePriority declaration order is the queue order: HIGH, MEDIUM, LOW.

CREATE TYPE "ServicePriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

ALTER TABLE "Stall" ADD COLUMN "servicePriority" "ServicePriority" NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE "Stall" ADD COLUMN "archivedAt" TIMESTAMP(3);

ALTER TABLE "Ticket" ADD COLUMN "servicePriority" "ServicePriority" NOT NULL DEFAULT 'MEDIUM';

CREATE INDEX "Ticket_queue_order_idx" ON "Ticket"("poolId", "status", "queuePriorityOverrideAt", "servicePriority", "createdAt");
