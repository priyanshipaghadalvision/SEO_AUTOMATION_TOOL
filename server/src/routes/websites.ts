import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { websites, crawls, auditEvents } from "../db/schema.js";
import { parseAndNormalizeUrl, assertPubliclyResolvable } from "../lib/url.js";
import { detectPlatform } from "../lib/platformDetect.js";
import { logAuditEvent } from "../lib/audit.js";
import { DEFAULT_CRAWL_LIMITS } from "../lib/crawlLimits.js";
import { validateBody } from "../middleware/validate.js";
import { createWebsiteSchema, createCrawlSchema } from "../schemas/website.js";

export const websitesRouter = Router();

/**
 * Loads a website only if it belongs to this user.
 *
 * Ownership is folded into the WHERE clause rather than checked after the
 * fetch, so another user's id can only ever produce "not found". Callers
 * return 404 (not 403) for a site owned by someone else -- confirming that
 * an id exists but isn't yours is itself an information leak.
 */
async function findOwnedWebsite(websiteId: string, userId: string) {
  const [website] = await db
    .select()
    .from(websites)
    .where(and(eq(websites.id, websiteId), eq(websites.userId, userId)));
  return website ?? null;
}

websitesRouter.get("/", async (req, res) => {
  const rows = await db
    .select()
    .from(websites)
    .where(eq(websites.userId, req.userId as string))
    .orderBy(websites.createdAt);
  res.json({ websites: rows });
});

/**
 * Permanently deletes a website and everything it owns: crawls, pages, and
 * audit history. There is no undo.
 *
 * `crawls` and `pages` disappear via ON DELETE CASCADE, but audit_events
 * deliberately has no foreign key (it's an append-only log that can outlive
 * its subject), so its rows are removed explicitly here -- otherwise a hard
 * delete would leave orphaned history behind and wouldn't really be "hard".
 *
 * An in-flight crawl is marked CANCELLED in the same transaction before the
 * rows go. runCrawl also treats a vanished crawl row as a cancellation, so a
 * worker mid-crawl on this site stops cleanly instead of erroring on writes
 * to rows that no longer exist.
 */
websitesRouter.delete("/:id", async (req, res) => {
  const id = req.params.id as string;

  const result = await db.transaction(async (tx) => {
    const [website] = await tx
      .select()
      .from(websites)
      .where(and(eq(websites.id, id), eq(websites.userId, req.userId as string)))
      .for("update");
    if (!website) return { error: "not_found" as const };

    await tx
      .update(crawls)
      .set({ status: "CANCELLED", finishedAt: new Date() })
      .where(and(eq(crawls.websiteId, id), inArray(crawls.status, ["QUEUED", "RUNNING"])));

    const crawlIds = (
      await tx.select({ id: crawls.id }).from(crawls).where(eq(crawls.websiteId, id))
    ).map((c) => c.id);

    if (crawlIds.length > 0) {
      await tx.delete(auditEvents).where(inArray(auditEvents.entityId, crawlIds));
    }
    await tx.delete(auditEvents).where(eq(auditEvents.entityId, id));

    // Cascades to crawls, and from there to pages.
    await tx.delete(websites).where(eq(websites.id, id));

    return { domain: website.domain, deletedCrawls: crawlIds.length };
  });

  if (result.error === "not_found") {
    res.status(404).json({ error: "not_found" });
    return;
  }

  console.log(`[api] deleted website ${result.domain} (${result.deletedCrawls} crawl(s))`);
  res.json({ deleted: true, domain: result.domain, deletedCrawls: result.deletedCrawls });
});

websitesRouter.get("/:id", async (req, res) => {
  const id = req.params.id as string;
  const website = await findOwnedWebsite(id, req.userId as string);
  if (!website) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const websiteCrawls = await db
    .select()
    .from(crawls)
    .where(eq(crawls.websiteId, website.id))
    .orderBy(crawls.createdAt);

  res.json({ website, crawls: websiteCrawls });
});

websitesRouter.post("/", validateBody(createWebsiteSchema), async (req, res) => {
  const { url } = req.body as { url: string };

  const normalized = parseAndNormalizeUrl(url);
  await assertPubliclyResolvable(normalized.hostname);

  // The domain column is globally unique, so a domain already tracked by a
  // DIFFERENT user must not reveal that user's row -- report the conflict
  // without echoing back a website the caller isn't allowed to see.
  const [existing] = await db.select().from(websites).where(eq(websites.domain, normalized.domain));
  if (existing) {
    if (existing.userId === req.userId) {
      res.status(409).json({ error: "website_exists", website: existing });
    } else {
      res.status(409).json({ error: "website_exists" });
    }
    return;
  }

  const detection = await detectPlatform(normalized.normalizedOrigin);

  const [website] = await db
    .insert(websites)
    .values({
      userId: req.userId as string,
      domain: normalized.domain,
      originalUrl: url.trim(),
      platform: detection.platform,
    })
    .returning();

  await logAuditEvent({
    entityType: "website",
    entityId: website.id,
    eventType: "website.created",
    metadata: { normalizedOrigin: normalized.normalizedOrigin, detection },
  });

  const [crawl] = await db
    .insert(crawls)
    .values({
      websiteId: website.id,
      status: "QUEUED",
      limits: {
        ...DEFAULT_CRAWL_LIMITS,
        allowedHosts: [normalized.domain],
      },
    })
    .returning();

  await logAuditEvent({
    entityType: "crawl",
    entityId: crawl.id,
    eventType: "crawl.created",
    metadata: { status: crawl.status, limits: crawl.limits },
  });

  res.status(201).json({ website, crawl, detection });
});

websitesRouter.post("/:id/redetect-platform", async (req, res) => {
  const id = req.params.id as string;
  const website = await findOwnedWebsite(id, req.userId as string);
  if (!website) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const normalized = parseAndNormalizeUrl(website.domain);
  const detection = await detectPlatform(normalized.normalizedOrigin);

  const [updated] = await db
    .update(websites)
    .set({ platform: detection.platform, updatedAt: new Date() })
    .where(eq(websites.id, id))
    .returning();

  await logAuditEvent({
    entityType: "website",
    entityId: website.id,
    eventType: "website.platform_redetected",
    metadata: { from: website.platform, to: detection.platform, detection },
  });

  res.json({ website: updated, detection });
});

websitesRouter.post("/:id/crawls", validateBody(createCrawlSchema), async (req, res) => {
  const id = req.params.id as string;
  const website = await findOwnedWebsite(id, req.userId as string);
  if (!website) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const overrides = req.body as {
    maxPages?: number;
    maxDepth?: number;
    timeLimitMinutes?: number;
    allowedHosts?: string[];
  };

  const [crawl] = await db
    .insert(crawls)
    .values({
      websiteId: website.id,
      status: "QUEUED",
      limits: {
        maxPages: overrides.maxPages ?? DEFAULT_CRAWL_LIMITS.maxPages,
        maxDepth: overrides.maxDepth ?? DEFAULT_CRAWL_LIMITS.maxDepth,
        timeLimitMinutes: overrides.timeLimitMinutes ?? DEFAULT_CRAWL_LIMITS.timeLimitMinutes,
        allowedHosts: overrides.allowedHosts ?? [website.domain],
      },
    })
    .returning();

  await logAuditEvent({
    entityType: "crawl",
    entityId: crawl.id,
    eventType: "crawl.created",
    metadata: { limits: crawl.limits },
  });

  res.status(201).json({ crawl });
});
