-- Forward-only repair for databases created from earlier migration revisions.
-- Legacy export scopes were JSONB; the current contract is a PostgreSQL text array.
CREATE FUNCTION "_eveops_jsonb_text_array"(value JSONB)
RETURNS TEXT[]
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT COALESCE(array_agg(item), ARRAY[]::TEXT[])
  FROM jsonb_array_elements_text(value) AS item
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ExportJob'
      AND column_name = 'eventIds'
      AND data_type = 'jsonb'
  ) THEN
    ALTER TABLE "ExportJob"
      ALTER COLUMN "eventIds" TYPE TEXT[]
      USING "_eveops_jsonb_text_array"("eventIds");
  END IF;
END $$;

DROP FUNCTION "_eveops_jsonb_text_array"(JSONB);

-- A legacy challenge without protected delivery material cannot be presented safely.
UPDATE "OtpChallenge"
SET "otpCiphertext" = '',
    "invalidatedAt" = COALESCE("invalidatedAt", NOW()),
    "activeTicketKey" = NULL
WHERE "otpCiphertext" IS NULL;

ALTER TABLE "OtpChallenge"
  ALTER COLUMN "otpCiphertext" SET NOT NULL;

ALTER TABLE "Complaint"
  ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Complaint_createdBy_idempotencyKey_key"
  ON "Complaint"("createdBy", "idempotencyKey");

CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "UserScope" s
    JOIN "User" u ON u.id = s."userId"
    JOIN "Event" e ON e.id = s."eventId"
    WHERE u."organizationId" <> e."organizationId"
  ) THEN
    RAISE EXCEPTION 'UserScope organization preflight failed';
  END IF;
END $$;

CREATE FUNCTION "enforce_user_scope_organization"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  user_organization TEXT;
  event_organization TEXT;
BEGIN
  SELECT "organizationId" INTO user_organization FROM "User" WHERE id = NEW."userId";
  SELECT "organizationId" INTO event_organization FROM "Event" WHERE id = NEW."eventId";
  IF user_organization IS DISTINCT FROM event_organization THEN
    RAISE EXCEPTION 'UserScope user and event must belong to the same organization';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "UserScope_same_organization"
BEFORE INSERT OR UPDATE OF "userId", "eventId" ON "UserScope"
FOR EACH ROW EXECUTE FUNCTION "enforce_user_scope_organization"();
