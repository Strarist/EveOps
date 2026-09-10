-- Preserve event ownership on every operational record (01 §2, 04 §16).
ALTER TABLE "Event" ADD COLUMN "ticketSequence" INTEGER NOT NULL DEFAULT 0;
UPDATE "Event" e
SET "ticketSequence" = (SELECT COUNT(*)::INTEGER FROM "Ticket" t WHERE t."eventId" = e.id);

ALTER TABLE "Zone" ADD COLUMN "eventId" TEXT;
UPDATE "Zone" z SET "eventId" = h."eventId" FROM "Hall" h WHERE z."hallId" = h.id;

ALTER TABLE "Stall" ADD COLUMN "eventId" TEXT;
UPDATE "Stall" s SET "eventId" = z."eventId" FROM "Zone" z WHERE s."zoneId" = z.id;

ALTER TABLE "WorkforceMembership" ADD COLUMN "eventId" TEXT;
UPDATE "WorkforceMembership" w SET "eventId" = p."eventId" FROM "ServicePool" p WHERE w."poolId" = p.id;

ALTER TABLE "Assignment" ADD COLUMN "eventId" TEXT;
ALTER TABLE "Assignment" ADD COLUMN "activeTicketKey" TEXT;
UPDATE "Assignment" a
SET "eventId" = t."eventId",
    "activeTicketKey" = CASE WHEN a.status IN ('ACTIVE', 'ACCEPTED') THEN a."ticketId" ELSE NULL END
FROM "Ticket" t
WHERE a."ticketId" = t.id;

ALTER TABLE "TicketEvent" ADD COLUMN "eventId" TEXT;
UPDATE "TicketEvent" e SET "eventId" = t."eventId" FROM "Ticket" t WHERE e."ticketId" = t.id;

ALTER TABLE "OtpChallenge" ADD COLUMN "eventId" TEXT;
UPDATE "OtpChallenge" o SET "eventId" = t."eventId" FROM "Ticket" t WHERE o."ticketId" = t.id;

ALTER TABLE "Complaint" ADD COLUMN "eventId" TEXT;
UPDATE "Complaint" c SET "eventId" = t."eventId" FROM "Ticket" t WHERE c."ticketId" = t.id;

ALTER TABLE "Notification" ADD COLUMN "eventId" TEXT;
UPDATE "Notification" n
SET "eventId" = COALESCE(
  (SELECT t."eventId" FROM "Ticket" t WHERE t.id = n."ticketId"),
  (SELECT s."eventId" FROM "UserScope" s WHERE s."userId" = n."recipientId" ORDER BY s.id LIMIT 1)
);

ALTER TABLE "OutboxEvent" ADD COLUMN "eventId" TEXT;
UPDATE "OutboxEvent" o
SET "eventId" = COALESCE(
  o.payload ->> 'eventId',
  (SELECT t."eventId" FROM "Ticket" t WHERE t.id = o."aggregateId")
);

ALTER TABLE "ExportJob" ADD COLUMN "eventIds" TEXT[];
UPDATE "ExportJob" e
SET "eventIds" = (
  SELECT COALESCE(array_agg(DISTINCT s."eventId"), ARRAY[]::TEXT[])
  FROM "UserScope" s
  WHERE s."userId" = e."requestedById"
);

ALTER TABLE "Zone" ALTER COLUMN "eventId" SET NOT NULL;
ALTER TABLE "Stall" ALTER COLUMN "eventId" SET NOT NULL;
ALTER TABLE "WorkforceMembership" ALTER COLUMN "eventId" SET NOT NULL;
ALTER TABLE "Assignment" ALTER COLUMN "eventId" SET NOT NULL;
ALTER TABLE "TicketEvent" ALTER COLUMN "eventId" SET NOT NULL;
ALTER TABLE "OtpChallenge" ALTER COLUMN "eventId" SET NOT NULL;
ALTER TABLE "Complaint" ALTER COLUMN "eventId" SET NOT NULL;
ALTER TABLE "Notification" ALTER COLUMN "eventId" SET NOT NULL;
ALTER TABLE "OutboxEvent" ALTER COLUMN "eventId" SET NOT NULL;
ALTER TABLE "ExportJob" ALTER COLUMN "eventIds" SET NOT NULL;

CREATE UNIQUE INDEX "Assignment_activeTicketKey_key" ON "Assignment"("activeTicketKey");
CREATE INDEX "Zone_eventId_idx" ON "Zone"("eventId");
CREATE INDEX "Stall_eventId_idx" ON "Stall"("eventId");
CREATE INDEX "WorkforceMembership_eventId_idx" ON "WorkforceMembership"("eventId");
CREATE INDEX "Assignment_eventId_idx" ON "Assignment"("eventId");
CREATE INDEX "TicketEvent_eventId_idx" ON "TicketEvent"("eventId");
CREATE INDEX "OtpChallenge_eventId_idx" ON "OtpChallenge"("eventId");
CREATE INDEX "Complaint_eventId_idx" ON "Complaint"("eventId");
CREATE INDEX "Notification_eventId_idx" ON "Notification"("eventId");
CREATE INDEX "OutboxEvent_eventId_idx" ON "OutboxEvent"("eventId");
