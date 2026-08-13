CREATE TYPE "public"."render_method" AS ENUM('http', 'browser');--> statement-breakpoint
ALTER TABLE "crawls" ALTER COLUMN "stats" SET DEFAULT '{"discovered":0,"processed":0,"failed":0,"skipped":0,"rendered":0}'::jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "meta_description" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "canonical_url" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "robots_meta" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "headings" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "images" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "structured_data" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "word_count" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "load_time_ms" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "render_method" "render_method";