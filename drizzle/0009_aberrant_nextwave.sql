CREATE TYPE "public"."gsc_property_type" AS ENUM('domain', 'url_prefix');--> statement-breakpoint
CREATE TABLE "gsc_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"google_email" text,
	"refresh_token_enc" text NOT NULL,
	"access_token" text,
	"access_token_expires_at" timestamp with time zone,
	"scopes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gsc_connections_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "gsc_page_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"page_url" text NOT NULL,
	"date" date NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" real NOT NULL,
	"position" real NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gsc_properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"website_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"site_url" text NOT NULL,
	"property_type" "gsc_property_type" NOT NULL,
	"permission_level" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gsc_properties_website_id_unique" UNIQUE("website_id")
);
--> statement-breakpoint
ALTER TABLE "gsc_connections" ADD CONSTRAINT "gsc_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_page_metrics" ADD CONSTRAINT "gsc_page_metrics_property_id_gsc_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."gsc_properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_properties" ADD CONSTRAINT "gsc_properties_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_properties" ADD CONSTRAINT "gsc_properties_connection_id_gsc_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."gsc_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gsc_connections_user_id_idx" ON "gsc_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_page_metrics_unique_idx" ON "gsc_page_metrics" USING btree ("property_id","page_url","date");--> statement-breakpoint
CREATE INDEX "gsc_page_metrics_property_date_idx" ON "gsc_page_metrics" USING btree ("property_id","date");--> statement-breakpoint
CREATE INDEX "gsc_page_metrics_url_idx" ON "gsc_page_metrics" USING btree ("property_id","page_url");--> statement-breakpoint
CREATE INDEX "gsc_properties_connection_idx" ON "gsc_properties" USING btree ("connection_id");