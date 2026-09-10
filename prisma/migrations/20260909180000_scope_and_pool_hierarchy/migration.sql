CREATE UNIQUE INDEX "ServicePool_id_eventId_hallId_key"
  ON "ServicePool"("id", "eventId", "hallId");

ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_poolId_eventId_hallId_fkey"
  FOREIGN KEY ("poolId", "eventId", "hallId")
  REFERENCES "ServicePool"("id", "eventId", "hallId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "UserScope" s
    JOIN "Stall" st ON st.id = s."stallId"
    JOIN "Zone" z ON z.id = st."zoneId"
    WHERE s."stallId" IS NOT NULL
      AND (s."hallId" IS NULL OR s."hallId" <> z."hallId")
  ) THEN
    RAISE EXCEPTION 'UserScope stall/hall preflight failed';
  END IF;
END $$;

CREATE FUNCTION "enforce_user_scope_stall_hall"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  stall_hall TEXT;
BEGIN
  IF NEW."stallId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT z."hallId" INTO stall_hall
  FROM "Stall" st
  JOIN "Zone" z ON z.id = st."zoneId"
  WHERE st.id = NEW."stallId";
  IF NEW."hallId" IS NULL OR NEW."hallId" IS DISTINCT FROM stall_hall THEN
    RAISE EXCEPTION 'UserScope stall must belong to its scoped hall';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "UserScope_stall_same_hall"
BEFORE INSERT OR UPDATE OF "hallId", "stallId" ON "UserScope"
FOR EACH ROW EXECUTE FUNCTION "enforce_user_scope_stall_hall"();
