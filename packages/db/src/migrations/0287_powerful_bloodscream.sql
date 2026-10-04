ALTER TABLE "owner_digest_human_waits" ADD COLUMN "ask_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "owner_digest_human_waits" ADD CONSTRAINT "owner_digest_human_waits_ask_issue_id_issues_id_fk" FOREIGN KEY ("ask_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "owner_digest_human_wait_ask_uq" ON "owner_digest_human_waits" USING btree ("ask_issue_id");--> statement-breakpoint
ALTER TABLE "owner_digest_human_waits" ADD CONSTRAINT "owner_digest_human_wait_distinct_ask_check" CHECK ("owner_digest_human_waits"."ask_issue_id" IS NULL OR "owner_digest_human_waits"."ask_issue_id" <> "owner_digest_human_waits"."origin_issue_id");
--> statement-breakpoint
CREATE FUNCTION owner_digest_human_wait_reject_ask_rebinding() RETURNS trigger AS $$
BEGIN
  IF OLD.ask_issue_id IS NOT NULL AND NEW.ask_issue_id IS DISTINCT FROM OLD.ask_issue_id THEN
    RAISE EXCEPTION 'owner_digest_human_wait ASK binding is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER owner_digest_human_wait_ask_immutable BEFORE UPDATE ON "owner_digest_human_waits"
FOR EACH ROW EXECUTE FUNCTION owner_digest_human_wait_reject_ask_rebinding();