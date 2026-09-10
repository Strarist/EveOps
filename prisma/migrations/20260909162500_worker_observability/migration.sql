CREATE TABLE "SystemHeartbeat" (
  "id" TEXT NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  CONSTRAINT "SystemHeartbeat_pkey" PRIMARY KEY ("id")
);
