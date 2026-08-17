CREATE TYPE "public"."gsc_search_type" AS ENUM('web', 'image');--> statement-breakpoint
ALTER TYPE "public"."gsc_dimension" ADD VALUE IF NOT EXISTS 'searchAppearance';--> statement-breakpoint
ALTER TABLE "gsc_page_metrics" ADD COLUMN "search_type" "gsc_search_type" DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "gsc_breakdowns" ADD COLUMN "search_type" "gsc_search_type" DEFAULT 'web' NOT NULL;--> statement-breakpoint
DROP INDEX "gsc_page_metrics_unique_idx";--> statement-breakpoint
DROP INDEX "gsc_page_metrics_property_date_idx";--> statement-breakpoint
DROP INDEX "gsc_breakdowns_unique_idx";--> statement-breakpoint
DROP INDEX "gsc_breakdowns_lookup_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_page_metrics_unique_idx" ON "gsc_page_metrics" USING btree ("property_id","page_url","date","search_type");--> statement-breakpoint
CREATE INDEX "gsc_page_metrics_property_date_idx" ON "gsc_page_metrics" USING btree ("property_id","search_type","date");--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_breakdowns_unique_idx" ON "gsc_breakdowns" USING btree ("property_id","dimension","search_type","key_value","window_start","window_end");--> statement-breakpoint
CREATE INDEX "gsc_breakdowns_lookup_idx" ON "gsc_breakdowns" USING btree ("property_id","search_type","dimension","window_end");
