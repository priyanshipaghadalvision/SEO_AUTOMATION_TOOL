CREATE TYPE "public"."optimization_action" AS ENUM('UPDATE_TITLE', 'UPDATE_DESCRIPTION', 'ADD_CANONICAL', 'ADD_H1', 'SET_IMAGE_ALT', 'ADD_SCHEMA', 'DEFER_SCRIPTS', 'FIX_REDIRECT_CHAIN', 'ADD_ROBOTS_TXT', 'ADD_SITEMAP');--> statement-breakpoint
CREATE TYPE "public"."optimization_source" AS ENUM('rule', 'ai');--> statement-breakpoint
CREATE TYPE "public"."optimization_status" AS ENUM('pending', 'approved', 'rejected', 'applied');--> statement-breakpoint
CREATE TABLE "optimizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crawl_id" uuid NOT NULL,
	"page_id" uuid,
	"issue_type" text NOT NULL,
	"action" "optimization_action" NOT NULL,
	"target" text,
	"dedupe_key" text NOT NULL,
	"old_value" text,
	"new_value" text NOT NULL,
	"reason" text NOT NULL,
	"confidence_pct" integer NOT NULL,
	"risk" "issue_risk" NOT NULL,
	"status" "optimization_status" DEFAULT 'pending' NOT NULL,
	"source" "optimization_source" NOT NULL,
	"model" text,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "optimizations" ADD CONSTRAINT "optimizations_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimizations" ADD CONSTRAINT "optimizations_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "optimizations_crawl_id_idx" ON "optimizations" USING btree ("crawl_id");--> statement-breakpoint
CREATE INDEX "optimizations_crawl_status_idx" ON "optimizations" USING btree ("crawl_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "optimizations_dedupe_idx" ON "optimizations" USING btree ("crawl_id","dedupe_key");