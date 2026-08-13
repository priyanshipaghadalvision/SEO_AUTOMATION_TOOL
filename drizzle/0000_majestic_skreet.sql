CREATE TYPE "public"."crawl_status" AS ENUM('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."platform_type" AS ENUM('nextjs', 'wordpress', 'shopify', 'react', 'custom', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."website_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"website_id" uuid NOT NULL,
	"status" "crawl_status" DEFAULT 'QUEUED' NOT NULL,
	"limits" jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "websites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" text NOT NULL,
	"original_url" text NOT NULL,
	"platform" "platform_type" DEFAULT 'unknown' NOT NULL,
	"status" "website_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "websites_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "crawls_website_id_idx" ON "crawls" USING btree ("website_id");--> statement-breakpoint
CREATE INDEX "websites_domain_idx" ON "websites" USING btree ("domain");