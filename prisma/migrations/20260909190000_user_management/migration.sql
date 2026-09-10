ALTER TABLE "Organization"
  ADD COLUMN "userSequence" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "User"
  ADD COLUMN "personCode" TEXT,
  ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT true;

WITH ranked AS (
  SELECT
    id,
    "organizationId",
    ROW_NUMBER() OVER (PARTITION BY "organizationId" ORDER BY "createdAt", id) AS sequence,
    CASE role
      WHEN 'STALL' THEN 'STL'
      WHEN 'STAFF' THEN 'STF'
      WHEN 'HALL_MANAGER' THEN 'HM'
      WHEN 'ADMIN' THEN 'ADM'
      WHEN 'SUPER_ADMIN' THEN 'SA'
    END AS prefix
  FROM "User"
)
UPDATE "User" AS target
SET
  "personCode" = ranked.prefix || '-' || LPAD(ranked.sequence::text, 5, '0'),
  "mustChangePassword" = false
FROM ranked
WHERE ranked.id = target.id;

UPDATE "Organization" AS organization
SET "userSequence" = (
  SELECT COUNT(*)::integer FROM "User" WHERE "organizationId" = organization.id
);

ALTER TABLE "User"
  ALTER COLUMN "personCode" SET NOT NULL;

CREATE UNIQUE INDEX "User_organizationId_personCode_key"
  ON "User"("organizationId", "personCode");

CREATE TABLE "UserManagementEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "eventId" TEXT,
  "hallId" TEXT,
  "actorId" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "reason" TEXT,
  "oldValue" JSONB,
  "newValue" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserManagementEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserManagementEvent_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "UserManagementEvent_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "UserManagementEvent_targetUserId_fkey"
    FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "UserManagementEvent_organizationId_createdAt_idx"
  ON "UserManagementEvent"("organizationId", "createdAt");
CREATE INDEX "UserManagementEvent_eventId_hallId_createdAt_idx"
  ON "UserManagementEvent"("eventId", "hallId", "createdAt");
CREATE INDEX "UserManagementEvent_targetUserId_createdAt_idx"
  ON "UserManagementEvent"("targetUserId", "createdAt");
