-- ExpoOps integrity hardening (04 §§5, 8, 11.1, 14, 16).
-- Fail before adding constraints if denormalized event/hierarchy data is inconsistent.
ALTER TABLE "OutboxEvent"
  ADD COLUMN "lockedAt" TIMESTAMP(3),
  ADD COLUMN "lockOwner" TEXT,
  ADD COLUMN "lastError" TEXT;
ALTER TABLE "ExportJob"
  ADD COLUMN "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastError" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Zone" z JOIN "Hall" h ON h.id = z."hallId"
    WHERE z."eventId" <> h."eventId"
  ) OR EXISTS (
    SELECT 1 FROM "Stall" s JOIN "Zone" z ON z.id = s."zoneId"
    WHERE s."eventId" <> z."eventId"
  ) OR EXISTS (
    SELECT 1 FROM "Ticket" t
    JOIN "Hall" h ON h.id = t."hallId"
    JOIN "Zone" z ON z.id = t."zoneId"
    JOIN "Stall" s ON s.id = t."stallId"
    WHERE t."eventId" <> h."eventId"
       OR z."hallId" <> t."hallId" OR z."eventId" <> t."eventId"
       OR s."zoneId" <> t."zoneId" OR s."eventId" <> t."eventId"
  ) THEN
    RAISE EXCEPTION 'ExpoOps hierarchy preflight failed; repair inconsistent event/hall/zone/stall data';
  END IF;
END $$;

CREATE UNIQUE INDEX "Hall_id_eventId_key" ON "Hall"("id", "eventId");
CREATE UNIQUE INDEX "Zone_id_eventId_key" ON "Zone"("id", "eventId");
CREATE UNIQUE INDEX "Zone_id_hallId_eventId_key" ON "Zone"("id", "hallId", "eventId");
CREATE UNIQUE INDEX "Stall_id_eventId_key" ON "Stall"("id", "eventId");
CREATE UNIQUE INDEX "Stall_id_zoneId_eventId_key" ON "Stall"("id", "zoneId", "eventId");
CREATE UNIQUE INDEX "ServicePool_id_eventId_key" ON "ServicePool"("id", "eventId");
CREATE UNIQUE INDEX "Ticket_id_eventId_key" ON "Ticket"("id", "eventId");

ALTER TABLE "Zone" ADD CONSTRAINT "Zone_hallId_eventId_fkey"
  FOREIGN KEY ("hallId", "eventId") REFERENCES "Hall"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Stall" ADD CONSTRAINT "Stall_zoneId_eventId_fkey"
  FOREIGN KEY ("zoneId", "eventId") REFERENCES "Zone"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServicePool" ADD CONSTRAINT "ServicePool_hallId_eventId_fkey"
  FOREIGN KEY ("hallId", "eventId") REFERENCES "Hall"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkforceMembership" ADD CONSTRAINT "WorkforceMembership_poolId_eventId_fkey"
  FOREIGN KEY ("poolId", "eventId") REFERENCES "ServicePool"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserScope" ADD CONSTRAINT "UserScope_hallId_eventId_fkey"
  FOREIGN KEY ("hallId", "eventId") REFERENCES "Hall"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserScope" ADD CONSTRAINT "UserScope_stallId_eventId_fkey"
  FOREIGN KEY ("stallId", "eventId") REFERENCES "Stall"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_hallId_eventId_fkey"
  FOREIGN KEY ("hallId", "eventId") REFERENCES "Hall"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_zoneId_hallId_eventId_fkey"
  FOREIGN KEY ("zoneId", "hallId", "eventId") REFERENCES "Zone"("id", "hallId", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_stallId_zoneId_eventId_fkey"
  FOREIGN KEY ("stallId", "zoneId", "eventId") REFERENCES "Stall"("id", "zoneId", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_ticketId_eventId_fkey"
  FOREIGN KEY ("ticketId", "eventId") REFERENCES "Ticket"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_ticketId_eventId_fkey"
  FOREIGN KEY ("ticketId", "eventId") REFERENCES "Ticket"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OtpChallenge" ADD CONSTRAINT "OtpChallenge_ticketId_eventId_fkey"
  FOREIGN KEY ("ticketId", "eventId") REFERENCES "Ticket"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_ticketId_eventId_fkey"
  FOREIGN KEY ("ticketId", "eventId") REFERENCES "Ticket"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_ticketId_eventId_fkey"
  FOREIGN KEY ("ticketId", "eventId") REFERENCES "Ticket"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OtpChallenge" ADD CONSTRAINT "OtpChallenge_verifiedBy_fkey"
  FOREIGN KEY ("verifiedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Assignment_one_active_per_ticket"
  ON "Assignment"("ticketId") WHERE status IN ('ACTIVE', 'ACCEPTED');
CREATE UNIQUE INDEX "OtpChallenge_one_active_per_ticket"
  ON "OtpChallenge"("ticketId") WHERE "invalidatedAt" IS NULL AND "verifiedAt" IS NULL;
CREATE UNIQUE INDEX "ServicePool_global_category_subtype_key"
  ON "ServicePool"("eventId", "category", "subtype") WHERE "hallId" IS NULL;

ALTER TABLE "Event" ADD CONSTRAINT "Event_valid_dates" CHECK ("startsAt" < "endsAt");
ALTER TABLE "ServicePool" ADD CONSTRAINT "ServicePool_positive_targets"
  CHECK ("responseTargetSeconds" > 0 AND "resolutionTargetSeconds" > 0);
ALTER TABLE "WorkforceMembership" ADD CONSTRAINT "WorkforceMembership_positive_capacity" CHECK (capacity > 0);
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_nonnegative_counters" CHECK ("reopenCount" >= 0 AND "escalationLevel" >= 0);
ALTER TABLE "OtpChallenge" ADD CONSTRAINT "OtpChallenge_valid_window"
  CHECK (attempts >= 0 AND "expiresAt" > "createdAt");

CREATE INDEX "UserScope_eventId_hallId_idx" ON "UserScope"("eventId", "hallId");
CREATE INDEX "UserScope_eventId_stallId_idx" ON "UserScope"("eventId", "stallId");
CREATE INDEX "WorkforceMembership_poolId_availability_lastAvailableAt_idx"
  ON "WorkforceMembership"("poolId", availability, "lastAvailableAt");
CREATE INDEX "Assignment_overdue_scan_idx"
  ON "Assignment"(status, "responseOverdueAt", "snoozedUntil", "assignedAt");
CREATE INDEX "Ticket_eventId_status_priority_createdAt_idx"
  ON "Ticket"("eventId", status, priority, "createdAt");
CREATE INDEX "Ticket_stallId_status_createdAt_idx" ON "Ticket"("stallId", status, "createdAt");
CREATE INDEX "TicketEvent_eventId_createdAt_idx" ON "TicketEvent"("eventId", "createdAt");
CREATE INDEX "Complaint_eventId_createdAt_idx" ON "Complaint"("eventId", "createdAt");
CREATE INDEX "Notification_eventId_sentAt_idx" ON "Notification"("eventId", "sentAt");
CREATE INDEX "OutboxEvent_eventId_createdAt_idx" ON "OutboxEvent"("eventId", "createdAt");
CREATE INDEX "OutboxEvent_processedAt_lockedAt_createdAt_idx"
  ON "OutboxEvent"("processedAt", "lockedAt", "createdAt");
CREATE INDEX "ExportJob_status_createdAt_idx" ON "ExportJob"(status, "createdAt");
CREATE INDEX "ExportJob_requestedById_createdAt_idx" ON "ExportJob"("requestedById", "createdAt");
