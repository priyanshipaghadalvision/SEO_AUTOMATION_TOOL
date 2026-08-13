CREATE TABLE "gsc_inspection_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"succeeded" boolean NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gsc_inspection_attempts" ADD CONSTRAINT "gsc_inspection_attempts_property_id_gsc_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."gsc_properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gsc_inspection_attempts_idx" ON "gsc_inspection_attempts" USING btree ("property_id","attempted_at");