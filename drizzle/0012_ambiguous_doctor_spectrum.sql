ALTER TABLE "gsc_page_metrics" ADD COLUMN "normalized_url" text;--> statement-breakpoint
ALTER TABLE "gsc_url_inspections" ADD COLUMN "normalized_url" text;--> statement-breakpoint
CREATE INDEX "gsc_page_metrics_normalized_idx" ON "gsc_page_metrics" USING btree ("property_id","normalized_url");--> statement-breakpoint
CREATE INDEX "gsc_url_inspections_normalized_idx" ON "gsc_url_inspections" USING btree ("property_id","normalized_url");