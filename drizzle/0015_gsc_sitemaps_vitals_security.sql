CREATE TABLE "gsc_sitemaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"path" text NOT NULL,
	"last_submitted" timestamp with time zone,
	"last_downloaded" timestamp with time zone,
	"is_pending" boolean DEFAULT false NOT NULL,
	"is_sitemaps_index" boolean DEFAULT false NOT NULL,
	"warnings" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"contents" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"website_id" uuid NOT NULL,
	"status" text NOT NULL,
	"threats" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_vitals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"website_id" uuid NOT NULL,
	"url" text NOT NULL,
	"strategy" text NOT NULL,
	"source" text NOT NULL,
	"performance_score" integer,
	"lcp_ms" integer,
	"inp_ms" integer,
	"cls" real,
	"fcp_ms" integer,
	"ttfb_ms" integer,
	"categories" jsonb,
	"overall" text,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gsc_sitemaps" ADD CONSTRAINT "gsc_sitemaps_property_id_gsc_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."gsc_properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_checks" ADD CONSTRAINT "security_checks_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_vitals" ADD CONSTRAINT "web_vitals_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_sitemaps_unique_idx" ON "gsc_sitemaps" USING btree ("property_id","path");--> statement-breakpoint
CREATE INDEX "gsc_sitemaps_property_id_idx" ON "gsc_sitemaps" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "security_checks_unique_idx" ON "security_checks" USING btree ("website_id");--> statement-breakpoint
CREATE INDEX "security_checks_website_id_idx" ON "security_checks" USING btree ("website_id");--> statement-breakpoint
CREATE UNIQUE INDEX "web_vitals_unique_idx" ON "web_vitals" USING btree ("website_id","url","strategy");--> statement-breakpoint
CREATE INDEX "web_vitals_website_id_idx" ON "web_vitals" USING btree ("website_id");