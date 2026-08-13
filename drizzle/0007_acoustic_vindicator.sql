CREATE TYPE "public"."issue_risk" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."issue_severity" AS ENUM('critical', 'warning', 'notice');--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crawl_id" uuid NOT NULL,
	"page_id" uuid,
	"type" text NOT NULL,
	"severity" "issue_severity" NOT NULL,
	"risk" "issue_risk" NOT NULL,
	"auto_fixable" boolean DEFAULT false NOT NULL,
	"message" text NOT NULL,
	"url" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "inbound_link_count" integer;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_crawl_id_idx" ON "issues" USING btree ("crawl_id");--> statement-breakpoint
CREATE INDEX "issues_crawl_type_idx" ON "issues" USING btree ("crawl_id","type");--> statement-breakpoint
CREATE INDEX "issues_crawl_severity_idx" ON "issues" USING btree ("crawl_id","severity");