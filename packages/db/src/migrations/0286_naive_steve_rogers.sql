CREATE TABLE "owner_digest_human_wait_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"origin_issue_id" uuid NOT NULL,
	"inbox_user_id" text NOT NULL,
	"answer_scope" jsonb NOT NULL,
	"producer_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owner_digest_human_waits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text DEFAULT '1' NOT NULL,
	"kind" text DEFAULT 'owner_digest' NOT NULL,
	"company_id" uuid NOT NULL,
	"origin_issue_id" uuid NOT NULL,
	"inbox_user_id" text NOT NULL,
	"answer_scope" jsonb NOT NULL,
	"producer_principal_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"presented_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_digest_human_wait_version_check" CHECK ("owner_digest_human_waits"."version" = '1'),
	CONSTRAINT "owner_digest_human_wait_kind_check" CHECK ("owner_digest_human_waits"."kind" = 'owner_digest'),
	CONSTRAINT "owner_digest_human_wait_status_check" CHECK ("owner_digest_human_waits"."status" IN ('queued', 'presented', 'answered', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "owner_digest_human_wait_authorizations" ADD CONSTRAINT "owner_digest_human_wait_authorizations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_digest_human_wait_authorizations" ADD CONSTRAINT "owner_digest_human_wait_authorizations_origin_issue_id_issues_id_fk" FOREIGN KEY ("origin_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_digest_human_waits" ADD CONSTRAINT "owner_digest_human_waits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_digest_human_waits" ADD CONSTRAINT "owner_digest_human_waits_origin_issue_id_issues_id_fk" FOREIGN KEY ("origin_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "owner_digest_human_wait_auth_exact_uq" ON "owner_digest_human_wait_authorizations" USING btree ("company_id","origin_issue_id","inbox_user_id","producer_principal_id",md5("answer_scope"::text));--> statement-breakpoint
CREATE UNIQUE INDEX "owner_digest_human_wait_identity_uq" ON "owner_digest_human_waits" USING btree ("company_id","origin_issue_id","inbox_user_id",md5("answer_scope"::text));--> statement-breakpoint
CREATE INDEX "owner_digest_human_wait_queued_idx" ON "owner_digest_human_waits" USING btree ("company_id","status","created_at");
--> statement-breakpoint
CREATE FUNCTION owner_digest_human_wait_reject_routing_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.origin_issue_id IS DISTINCT FROM OLD.origin_issue_id
    OR NEW.inbox_user_id IS DISTINCT FROM OLD.inbox_user_id
    OR NEW.answer_scope IS DISTINCT FROM OLD.answer_scope
    OR NEW.producer_principal_id IS DISTINCT FROM OLD.producer_principal_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'owner_digest_human_wait routing fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER owner_digest_human_wait_routing_immutable BEFORE UPDATE ON "owner_digest_human_waits"
FOR EACH ROW EXECUTE FUNCTION owner_digest_human_wait_reject_routing_mutation();