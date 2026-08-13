CREATE TYPE "public"."gsc_verdict" AS ENUM('PASS', 'PARTIAL', 'FAIL', 'NEUTRAL', 'VERDICT_UNSPECIFIED');--> statement-breakpoint
CREATE TABLE "gsc_url_inspections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"page_url" text NOT NULL,
	"verdict" "gsc_verdict" NOT NULL,
	"coverage_state" text,
	"robots_txt_state" text,
	"indexing_state" text,
	"page_fetch_state" text,
	"google_canonical" text,
	"user_canonical" text,
	"last_crawl_time" timestamp with time zone,
	"crawled_as" text,
	"sitemaps" jsonb,
	"raw" jsonb,
	"inspected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gsc_url_inspections" ADD CONSTRAINT "gsc_url_inspections_property_id_gsc_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."gsc_properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_url_inspections_unique_idx" ON "gsc_url_inspections" USING btree ("property_id","page_url");--> statement-breakpoint
CREATE INDEX "gsc_url_inspections_verdict_idx" ON "gsc_url_inspections" USING btree ("property_id","verdict");--> statement-breakpoint
CREATE INDEX "gsc_url_inspections_inspected_idx" ON "gsc_url_inspections" USING btree ("property_id","inspected_at");