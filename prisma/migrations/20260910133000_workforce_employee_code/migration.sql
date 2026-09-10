-- Align user management with MVP workforce identity:
-- public optional employeeCode (not PK), ManagementAudit, drop interim personCode fields.
-- Person age is not an MVP operational field (ticket age is separate and server-derived).

CREATE TABLE "ManagementAudit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventId" TEXT,
    "actorId" TEXT NOT NULL,
    "targetUserId" TEXT,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ManagementAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ManagementAudit_organizationId_createdAt_idx" ON "ManagementAudit"("organizationId", "createdAt");
CREATE INDEX "ManagementAudit_eventId_createdAt_idx" ON "ManagementAudit"("eventId", "createdAt");
CREATE INDEX "ManagementAudit_targetUserId_createdAt_idx" ON "ManagementAudit"("targetUserId", "createdAt");

ALTER TABLE "ManagementAudit" ADD CONSTRAINT "ManagementAudit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManagementAudit" ADD CONSTRAINT "ManagementAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManagementAudit" ADD CONSTRAINT "ManagementAudit_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "ManagementAudit" ("id", "organizationId", "eventId", "actorId", "targetUserId", "action", "metadata", "createdAt")
SELECT
  "id",
  "organizationId",
  "eventId",
  "actorId",
  "targetUserId",
  "action",
  jsonb_strip_nulls(jsonb_build_object('reason', "reason", 'oldValue', "oldValue", 'newValue', "newValue", 'hallId', "hallId")),
  "createdAt"
FROM "UserManagementEvent";

DROP TABLE "UserManagementEvent";

DROP INDEX IF EXISTS "User_organizationId_personCode_key";

ALTER TABLE "User" RENAME COLUMN "personCode" TO "employeeCode";
ALTER TABLE "User" ALTER COLUMN "employeeCode" DROP NOT NULL;
CREATE UNIQUE INDEX "User_employeeCode_key" ON "User"("employeeCode");

ALTER TABLE "User" DROP COLUMN "mustChangePassword";
ALTER TABLE "Organization" DROP COLUMN "userSequence";
