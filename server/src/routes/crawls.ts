import { Router } from "express";
import { and, eq, ilike, or, sql, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { crawls, issues, optimizations, pages, websites } from "../db/schema.js";
import { logAuditEvent } from "../lib/audit.js";
import { analyzeCrawl } from "../analysis/analyzeCrawl.js";
import { generateOptimizations } from "../optimization/generateOptimizations.js";
import { validateBody } from "../middleware/validate.js";
import { updateCrawlStatusSchema } from "../schemas/website.js";

const PAGES_DEFAULT_LIMIT = 200;
const PAGES_MAX_LIMIT = 500;
const ISSUES_MAX = 2000;
/**
 * Proposals per request -- a page size, not a ceiling. This was a hard 2,000
 * cap that hid every proposal past it behind a "truncated" note; the pager
 * now walks the full set.
 */
const OPTIMIZATIONS_MAX = 500;

const OPTIMIZATION_STATUSES = ["pending", "approved", "rejected", "applied"] as const;
type OptimizationStatus = (typeof OPTIMIZATION_STATUSES)[number];

/**
 * Columns returned by the paginated page list.
 *
 * Deliberately excludes the heavy fields -- contentText (up to 40k chars),
 * internalLinks/externalLinks (up to 400 entries), headings, images,
 * structuredData, openGraph and hreflang. Returning them for 200 rows would
 * be a multi-megabyte response for data the table never displays; they are
 * fetched per-page by the detail endpoint below, only when a row is actually
 * expanded. Counts and flags are kept so the list can still show scale and
 * indexability at a glance.
 */
const PAGE_LIST_COLUMNS = {
  id: pages.id,
  crawlId: pages.crawlId,
  url: pages.url,
  normalizedUrl: pages.normalizedUrl,
  httpStatus: pages.httpStatus,
  finalUrl: pages.finalUrl,
  depth: pages.depth,
  errorMessage: pages.errorMessage,
  title: pages.title,
  wordCount: pages.wordCount,
  renderMethod: pages.renderMethod,
  contentHash: pages.contentHash,
  internalLinkCount: pages.internalLinkCount,
  externalLinkCount: pages.externalLinkCount,
  noindex: pages.noindex,
  nofollow: pages.nofollow,
  loadTimeMs: pages.loadTimeMs,
  responseTimeMs: pages.responseTimeMs,
  htmlBytes: pages.htmlBytes,
  discoveredAt: pages.discoveredAt,
} as const;

export const crawlsRouter = Router();

/**
 * Confirms this crawl belongs to the caller, via its website's owner.
 *
 * Crawl ids are handed to the client, so without this check any user could
 * read another user's pages, content and duplicates by passing a crawl id
 * straight to these endpoints -- the classic IDOR hole. The join makes
 * ownership part of the query rather than an afterthought.
 */
async function findOwnedCrawl(crawlId: string, userId: string) {
  const [row] = await db
    .select({ crawl: crawls })
    .from(crawls)
    .innerJoin(websites, eq(websites.id, crawls.websiteId))
    .where(and(eq(crawls.id, crawlId), eq(websites.userId, userId)));
  return row?.crawl ?? null;
}


type CrawlStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

const VALID_TRANSITIONS: Record<CrawlStatus, CrawlStatus[]> = {
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

crawlsRouter.get("/:id", async (req, res) => {
  const id = req.params.id as string;
  const crawl = await findOwnedCrawl(id, req.userId as string);
  if (!crawl) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ crawl });
});

crawlsRouter.get("/:id/pages", async (req, res) => {
  const id = req.params.id as string;

  const crawl = await findOwnedCrawl(id, req.userId as string);
  if (!crawl) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const limit = Math.min(PAGES_MAX_LIMIT, Math.max(1, Number(req.query.limit) || PAGES_DEFAULT_LIMIT));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const search = typeof req.query.search === "string" && req.query.search.trim() ? req.query.search.trim() : null;

  /*
   * Search runs in the database, not the browser.
   *
   * It used to filter whichever page happened to be loaded, so on a
   * 10,000-page crawl a term was matched against 200 rows and "no matches"
   * meant "not in this page" -- indistinguishable from "not in this crawl".
   */
  const filters = [eq(pages.crawlId, id)];
  if (req.query.noindex === "true") {
    filters.push(eq(pages.noindex, true));
  }
  if (search) {
    const like = `%${search}%`;
    filters.push(or(ilike(pages.url, like), ilike(pages.title, like))!);
  }
  const where = and(...filters);

  const [rows, [{ total }], [{ matched }]] = await Promise.all([
    db
      .select(PAGE_LIST_COLUMNS)
      .from(pages)
      // `id` breaks discoveredAt ties: pages inserted in the same batch share
      // a timestamp, and an unstable order duplicates or skips rows paging.
      .orderBy(desc(pages.discoveredAt), pages.id)
      .where(where)
      .limit(limit)
      .offset(offset),
    db.select({ total: sql<number>`count(*)::int` }).from(pages).where(eq(pages.crawlId, id)),
    db.select({ matched: sql<number>`count(*)::int` }).from(pages).where(where),
  ]);

  // `total` is the crawl's page count (headline), `matched` respects the
  // search term (what the pager walks). They differ only while filtering.
  res.json({ pages: rows, total, matched, limit, offset });
});

/** Full record for one page, including every heavy field omitted from the list. */
crawlsRouter.get("/:id/pages/:pageId", async (req, res) => {
  if (!(await findOwnedCrawl(req.params.id as string, req.userId as string))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const [page] = await db
    .select()
    .from(pages)
    .where(and(eq(pages.crawlId, req.params.id as string), eq(pages.id, req.params.pageId as string)));

  if (!page) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ page });
});

/**
 * Groups of pages whose content is byte-identical (same content hash), which
 * is the duplicate-content signal. Computed in Postgres rather than in the
 * client so a 100k-page crawl doesn't have to be shipped over the wire to
 * find its duplicates.
 */
crawlsRouter.get("/:id/duplicates", async (req, res) => {
  const id = req.params.id as string;
  if (!(await findOwnedCrawl(id, req.userId as string))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { rows } = await db.execute(sql`
    SELECT content_hash AS hash,
           count(*)::int AS count,
           (array_agg(url ORDER BY depth, url))[1:10] AS urls
    FROM pages
    WHERE crawl_id = ${id}
      AND content_hash IS NOT NULL
      AND word_count > 0
    GROUP BY content_hash
    HAVING count(*) > 1
    ORDER BY count(*) DESC
    LIMIT 100
  `);
  res.json({ duplicateGroups: rows });
});

/**
 * All SEO issues found for a crawl, plus rollups the UI needs to render
 * summary counts without pulling the whole list.
 */
crawlsRouter.get("/:id/issues", async (req, res) => {
  const id = req.params.id as string;
  if (!(await findOwnedCrawl(id, req.userId as string))) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const severityFilter = req.query.severity as string | undefined;
  const typeFilter = req.query.type as string | undefined;
  // Paged so a type with more instances than the bulk cap is still fully
  // reachable. Without this the UI could only say "not loaded" for anything
  // past the first 2,000 issues of a crawl.
  const limit = Math.min(ISSUES_MAX, Math.max(1, Number(req.query.limit) || ISSUES_MAX));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const conditions = [eq(issues.crawlId, id)];
  if (severityFilter === "critical" || severityFilter === "warning" || severityFilter === "notice") {
    conditions.push(eq(issues.severity, severityFilter));
  }
  if (typeFilter) conditions.push(eq(issues.type, typeFilter));

  const [rows, bySeverity, byType, [{ matched }]] = await Promise.all([
    db
      .select()
      .from(issues)
      .where(and(...conditions))
      // Ordered by id as the tiebreaker so paging is stable: without a unique
      // final sort key, two pages can repeat or skip rows.
      .orderBy(issues.severity, issues.type, issues.id)
      .limit(limit)
      .offset(offset),
    db
      .select({ severity: issues.severity, count: sql<number>`count(*)::int` })
      .from(issues)
      .where(eq(issues.crawlId, id))
      .groupBy(issues.severity),
    db
      .select({
        type: issues.type,
        severity: issues.severity,
        risk: issues.risk,
        autoFixable: issues.autoFixable,
        count: sql<number>`count(*)::int`,
      })
      .from(issues)
      .where(eq(issues.crawlId, id))
      .groupBy(issues.type, issues.severity, issues.risk, issues.autoFixable)
      .orderBy(sql`count(*) DESC`),
    // Total for the *filtered* set, so the UI can offer "load more" against a
    // real number rather than guessing from a full page.
    db.select({ matched: sql<number>`count(*)::int` }).from(issues).where(and(...conditions)),
  ]);

  res.json({
    issues: rows,
    bySeverity,
    byType,
    matched,
    limit,
    offset,
    hasMore: offset + rows.length < matched,
    truncated: rows.length >= ISSUES_MAX,
  });
});

/** Re-runs analysis against already-crawled data. No re-crawl, no new requests. */
crawlsRouter.post("/:id/analyze", async (req, res) => {
  const id = req.params.id as string;
  if (!(await findOwnedCrawl(id, req.userId as string))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const result = await analyzeCrawl(id);
  await logAuditEvent({ entityType: "crawl", entityId: id, eventType: "crawl.analyzed", metadata: result });
  res.json(result);
});

/**
 * Generates concrete fixes for this crawl's auto-fixable issues.
 *
 * Synchronous by design when the AI engine is off (the rule engine is pure
 * string work and returns in milliseconds). With a key configured the run
 * makes one model call per page, capped by OPTIMIZER_MAX_PAGES, so the
 * response can take a while on a large crawl -- the cap is what keeps that
 * bounded rather than open-ended.
 */
crawlsRouter.post("/:id/optimize", async (req, res) => {
  const id = req.params.id as string;
  if (!(await findOwnedCrawl(id, req.userId as string))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const result = await generateOptimizations(id);
  await logAuditEvent({
    entityType: "crawl",
    entityId: id,
    eventType: "crawl.optimized",
    metadata: result,
  });
  res.json(result);
});

/** Stored proposals for a crawl, plus the rollups the review UI renders. */
crawlsRouter.get("/:id/optimizations", async (req, res) => {
  const id = req.params.id as string;
  if (!(await findOwnedCrawl(id, req.userId as string))) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const statusFilter = req.query.status as string | undefined;
  const conditions = [eq(optimizations.crawlId, id)];
  if (OPTIMIZATION_STATUSES.includes(statusFilter as OptimizationStatus)) {
    conditions.push(eq(optimizations.status, statusFilter as OptimizationStatus));
  }

  const limit = Math.min(OPTIMIZATIONS_MAX, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const [rows, byAction, byStatus, [{ matched }]] = await Promise.all([
    db
      .select()
      .from(optimizations)
      .where(and(...conditions))
      // Highest-confidence proposals first so the easiest wins are at the top.
      // `id` breaks ties: without it, equal-confidence rows can be ordered
      // differently between pages and a proposal shows twice or never.
      .orderBy(optimizations.action, desc(optimizations.confidence), optimizations.id)
      .limit(limit)
      .offset(offset),
    db
      .select({
        action: optimizations.action,
        source: optimizations.source,
        count: sql<number>`count(*)::int`,
      })
      .from(optimizations)
      .where(eq(optimizations.crawlId, id))
      .groupBy(optimizations.action, optimizations.source)
      .orderBy(sql`count(*) DESC`),
    db
      .select({ status: optimizations.status, count: sql<number>`count(*)::int` })
      .from(optimizations)
      .where(eq(optimizations.crawlId, id))
      .groupBy(optimizations.status),
    // Counted with the status filter applied -- that is what the pager walks.
    db
      .select({ matched: sql<number>`count(*)::int` })
      .from(optimizations)
      .where(and(...conditions)),
  ]);

  res.json({
    optimizations: rows,
    byAction,
    byStatus,
    matched,
    offset,
    limit,
  });
});

/**
 * Records a human decision on one proposal.
 *
 * Ownership is folded into the UPDATE's WHERE clause via the crawl check
 * above plus the crawl_id predicate here, so a proposal id from another
 * user's crawl updates nothing and reports 404 rather than 403 -- the same
 * not-found response an id that doesn't exist gets, which leaks nothing about
 * what other accounts contain.
 */
crawlsRouter.patch("/:id/optimizations/:optimizationId", async (req, res) => {
  const id = req.params.id as string;
  if (!(await findOwnedCrawl(id, req.userId as string))) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const { status } = req.body as { status?: string };
  if (!OPTIMIZATION_STATUSES.includes(status as OptimizationStatus)) {
    res.status(400).json({ error: "invalid_status", allowed: OPTIMIZATION_STATUSES });
    return;
  }

  const [updated] = await db
    .update(optimizations)
    .set({ status: status as OptimizationStatus, updatedAt: new Date() })
    .where(and(eq(optimizations.crawlId, id), eq(optimizations.id, req.params.optimizationId as string)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  await logAuditEvent({
    entityType: "optimization",
    entityId: updated.id,
    eventType: "optimization.reviewed",
    metadata: { crawlId: id, action: updated.action, status: updated.status },
  });

  res.json({ optimization: updated });
});

/**
 * Cancels a QUEUED or RUNNING crawl.
 *
 * The row is locked FOR UPDATE so this can't interleave with the worker's
 * claim transaction: either the cancel lands first (and the worker's
 * `WHERE status = 'QUEUED'` claim then finds nothing), or the claim lands
 * first (and this marks the now-RUNNING crawl CANCELLED, which the running
 * crawl notices on its next cancellation poll and aborts).
 */
crawlsRouter.post("/:id/cancel", async (req, res) => {
  const id = req.params.id as string;

  if (!(await findOwnedCrawl(id, req.userId as string))) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [crawl] = await tx.select().from(crawls).where(eq(crawls.id, id)).for("update");
    if (!crawl) return { error: "not_found" as const };
    if (crawl.status !== "QUEUED" && crawl.status !== "RUNNING") {
      return { error: "not_cancellable" as const, status: crawl.status };
    }

    const [updated] = await tx
      .update(crawls)
      .set({ status: "CANCELLED", finishedAt: new Date() })
      .where(eq(crawls.id, id))
      .returning();

    return { crawl: updated, previousStatus: crawl.status };
  });

  if (result.error === "not_found") {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (result.error === "not_cancellable") {
    res.status(409).json({ error: "not_cancellable", status: result.status });
    return;
  }

  await logAuditEvent({
    entityType: "crawl",
    entityId: id,
    eventType: "crawl.cancelled",
    metadata: { from: result.previousStatus, statsAtCancel: result.crawl.stats },
  });

  res.json({ crawl: result.crawl });
});

crawlsRouter.patch("/:id/status", validateBody(updateCrawlStatusSchema), async (req, res) => {
  const id = req.params.id as string;
  const { status } = req.body as { status: CrawlStatus };

  const crawl = await findOwnedCrawl(id, req.userId as string);
  if (!crawl) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const allowed = VALID_TRANSITIONS[crawl.status] ?? [];
  if (!allowed.includes(status)) {
    res.status(409).json({ error: "invalid_transition", from: crawl.status, to: status });
    return;
  }

  const now = new Date();
  const patch: Partial<typeof crawls.$inferInsert> = { status };
  if (status === "RUNNING") patch.startedAt = now;
  if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") patch.finishedAt = now;

  const [updated] = await db.update(crawls).set(patch).where(eq(crawls.id, crawl.id)).returning();

  await logAuditEvent({
    entityType: "crawl",
    entityId: crawl.id,
    eventType: "crawl.status_changed",
    metadata: { from: crawl.status, to: status },
  });

  res.json({ crawl: updated });
});
