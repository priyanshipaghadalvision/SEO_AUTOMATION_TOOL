import { z } from "zod";

export const createWebsiteSchema = z.object({
  url: z.string().min(1, "url is required"),
});

export const createCrawlSchema = z.object({
  maxPages: z.number().int().positive().max(200_000).optional(),
  maxDepth: z.number().int().positive().max(50).optional(),
  timeLimitMinutes: z.number().int().positive().max(1440).optional(),
  allowedHosts: z.array(z.string()).optional(),
});

export const updateCrawlStatusSchema = z.object({
  status: z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),
});
