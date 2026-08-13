ALTER TABLE "crawls" ADD COLUMN "site_audit" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "scripts" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "script_count" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "inline_script_count" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "blocking_script_count" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "third_party_origins" jsonb;