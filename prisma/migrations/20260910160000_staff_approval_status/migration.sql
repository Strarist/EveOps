-- Staff approval workflow for Hall Manager-created Electrical / House Help accounts.

CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED');

ALTER TABLE "User"
  ADD COLUMN "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN "requestedById" TEXT,
  ADD COLUMN "approvedById" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedById" TEXT,
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "rejectionReason" TEXT;

ALTER TABLE "User"
  ADD CONSTRAINT "User_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "User_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "User_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "User_approvalStatus_status_idx" ON "User"("approvalStatus", "status");
