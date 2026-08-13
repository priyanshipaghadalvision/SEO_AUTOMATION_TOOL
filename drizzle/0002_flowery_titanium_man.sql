CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crawl_id" uuid NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"http_status" integer,
	"final_url" text,
	"redirect_chain" jsonb,
	"depth" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "stats" jsonb DEFAULT '{"discovered":0,"processed":0,"failed":0,"skipped":0}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pages_crawl_id_idx" ON "pages" USING btree ("crawl_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_crawl_normalized_url_idx" ON "pages" USING btree ("crawl_id","normalized_url");