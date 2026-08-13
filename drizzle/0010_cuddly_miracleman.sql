CREATE TYPE "public"."gsc_dimension" AS ENUM('query', 'device', 'country');--> statement-breakpoint
CREATE TABLE "gsc_breakdowns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"dimension" "gsc_dimension" NOT NULL,
	"key_value" text NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" real NOT NULL,
	"position" real NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gsc_breakdowns" ADD CONSTRAINT "gsc_breakdowns_property_id_gsc_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."gsc_properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_breakdowns_unique_idx" ON "gsc_breakdowns" USING btree ("property_id","dimension","key_value","window_start","window_end");--> statement-breakpoint
CREATE INDEX "gsc_breakdowns_lookup_idx" ON "gsc_breakdowns" USING btree ("property_id","dimension","window_end");