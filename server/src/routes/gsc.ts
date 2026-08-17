import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { crawls, gscBreakdowns, gscConnections, gscPageMetrics, gscProperties, gscSitemaps, gscUrlInspections, websites } from "../db/schema.js";
import { canReadData, listSites } from "../gsc/client.js";
import {
  GscConnectionExpiredError,
  GscNotConfiguredError,
  buildAuthUrl,
  disconnect,
  exchangeCodeAndStore,
  gscConfig,
  verifyState,
} from "../gsc/oauth.js";
import { inspectPropertyUrls } from "../gsc/inspectUrls.js";
import { latestUsableDate, provisionalStartDate, resolveRange } from "../gsc/dateRange.js";
import { ensureRangeData } from "../gsc/ensureRange.js";
import { getMergedUrls } from "../gsc/mergedUrls.js";
import type { Bucket } from "../gsc/mergedUrls.js";
import { matchesDomain, propertyTypeOf, syncPropertyMetrics } from "../gsc/syncMetrics.js";
import { syncSitemaps } from "../gsc/sitemapsSync.js";
import { getWebVitalsRows, runWebVitals } from "../gsc/webVitals.js";
import { getEnhancements, getLinkInsights, getMobileUsability } from "../gsc/siteInsights.js";
import { getCoverage } from "../gsc/coverage.js";
import { checkSite, getSecurityStatus } from "../gsc/safeBrowsing.js";
import { logAuditEvent } from "../lib/audit.js";
import { DEFAULT_CRAWL_LIMITS } from "../lib/crawlLimits.js";

/** How long a live range pull may block the request before we serve stored data. */
const RANGE_FETCH_TIMEOUT_MS = 25_000;

export const gscRouter = Router();

/**
 * Routes that must NOT sit behind `requireAuth`.
 *
 * Only Google's redirect target belongs here. It arrives as a top-level
 * browser navigation from accounts.google.com, and whether the session
 * cookie is attached to a cross-site navigation depends on SameSite policy --
 * requiring the cookie would make the flow fail intermittently. The signed
 * `state` parameter carries the identity instead.
 */
export const gscPublicRouter = Router();

/**
 * Runs a handler that talks to Google, turning a dead grant into a 409 the
 * UI can act on rather than a 500.
 *
 * A 409 says "the state of this resource is wrong, here is what to do";
 * a 500 says "we broke". Weekly token expiry under Testing status is the
 * former, and telling them apart is the difference between a reconnect
 * prompt and a bug report.
 */
async function withGoogle(res: import("express").Response, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof GscConnectionExpiredError) {
      res.status(409).json({ error: "connection_expired", message: err.message });
      return;
    }
    throw err;
  }
}

/**
 * Where the browser lands after the OAuth round-trip completes or fails.
 *
 * The trailing slash is stripped because every caller appends its own path:
 * an APP_URL of "https://host/" would otherwise produce "https://host//?gsc=..",
 * and a double slash is a different origin path that some proxies rewrite and
 * some don't.
 */
function appUrl(): string {
  const configured = process.env.APP_URL?.trim() || process.env.CORS_ORIGIN?.trim();
  return (configured || "http://localhost:5173").replace(/\/+$/, "");
}

/**
 * Columns safe to return.
 *
 * `refreshTokenEnc` and `accessToken` are deliberately absent: no endpoint
 * has a reason to hand a Google credential back to the browser, and
 * selecting explicitly means a future `select()` can't start leaking them by
 * accident.
 */
const CONNECTION_PUBLIC_COLUMNS = {
  id: gscConnections.id,
  googleEmail: gscConnections.googleEmail,
  scopes: gscConnections.scopes,
  createdAt: gscConnections.createdAt,
} as const;

/** Whether Search Console is configured, and whether this user has connected. */
gscRouter.get("/status", async (req, res) => {
  const configured = gscConfig() !== null;
  const [connection] = await db
    .select(CONNECTION_PUBLIC_COLUMNS)
    .from(gscConnections)
    .where(eq(gscConnections.userId, req.userId as string));

  res.json({
    configured,
    connected: Boolean(connection),
    connection: connection ?? null,
    setupHint: configured
      ? null
      : "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the root .env, then restart the server.",
  });
});

/**
 * Starts the OAuth flow.
 *
 * Returns the URL as JSON rather than issuing a redirect: the caller is a
 * `fetch` from the SPA, and a 302 to accounts.google.com would be followed by
 * the fetch and fail CORS instead of moving the user's browser.
 */
gscRouter.get("/connect", (req, res) => {
  try {
    res.json({ authUrl: buildAuthUrl(req.userId as string) });
  } catch (err) {
    if (err instanceof GscNotConfiguredError) {
      res.status(503).json({ error: "not_configured", message: err.message });
      return;
    }
    throw err;
  }
});

/**
 * Google's redirect target. Unauthenticated by necessity -- see
 * `gscPublicRouter` above for why, and why `state` is the identity proof.
 */
gscPublicRouter.get("/callback", async (req, res) => {
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };

  if (error) {
    res.redirect(`${appUrl()}/?gsc=denied`);
    return;
  }

  const userId = verifyState(state);
  if (!userId || !code) {
    res.redirect(`${appUrl()}/?gsc=invalid_state`);
    return;
  }

  try {
    const { googleEmail } = await exchangeCodeAndStore(userId, code);
    await logAuditEvent({
      entityType: "user",
      entityId: userId,
      eventType: "gsc.connected",
      metadata: { googleEmail },
    });
    res.redirect(`${appUrl()}/?gsc=connected`);
  } catch (err) {
    console.error("[gsc] callback failed:", err);
    res.redirect(`${appUrl()}/?gsc=failed`);
  }
});

/**
 * Properties the connected Google account can read, each annotated with the
 * website it is already linked to (if any) and whether its domain looks like
 * a match, so the picker can put the obvious choice first.
 */
gscRouter.get("/properties", async (req, res) => {
  const userId = req.userId as string;
  const [connection] = await db
    .select({ id: gscConnections.id })
    .from(gscConnections)
    .where(eq(gscConnections.userId, userId));
  if (!connection) {
    res.status(409).json({ error: "not_connected" });
    return;
  }

  await withGoogle(res, async () => {
    const [sites, owned, links] = await Promise.all([
      listSites(userId),
      db.select({ id: websites.id, domain: websites.domain }).from(websites).where(eq(websites.userId, userId)),
      db
        .select({ websiteId: gscProperties.websiteId, siteUrl: gscProperties.siteUrl })
        .from(gscProperties)
        .where(eq(gscProperties.connectionId, connection.id)),
    ]);

    const linkedBySiteUrl = new Map(links.map((l) => [l.siteUrl, l.websiteId]));

    res.json({
      properties: sites.map((s) => ({
        siteUrl: s.siteUrl,
        permissionLevel: s.permissionLevel,
        propertyType: propertyTypeOf(s.siteUrl),
        // Surfaced so the picker can grey out properties that would 403 on
        // sync, rather than letting them look identical to usable ones.
        canReadData: canReadData(s.permissionLevel),
        linkedWebsiteId: linkedBySiteUrl.get(s.siteUrl) ?? null,
        suggestedWebsiteIds: owned.filter((w) => matchesDomain(s.siteUrl, w.domain)).map((w) => w.id),
      })),
    });
  });
});

/** Links one Search Console property to one crawled website. */
gscRouter.post("/link", async (req, res) => {
  const userId = req.userId as string;
  const { websiteId, siteUrl } = req.body as { websiteId?: string; siteUrl?: string };
  if (!websiteId || !siteUrl) {
    res.status(400).json({ error: "websiteId and siteUrl are required" });
    return;
  }

  const [connection] = await db
    .select({ id: gscConnections.id })
    .from(gscConnections)
    .where(eq(gscConnections.userId, userId));
  if (!connection) {
    res.status(409).json({ error: "not_connected" });
    return;
  }

  // Ownership folded into the lookup: another user's websiteId matches
  // nothing and reports 404, the same as an id that doesn't exist.
  const [website] = await db
    .select({ id: websites.id })
    .from(websites)
    .where(and(eq(websites.id, websiteId), eq(websites.userId, userId)));
  if (!website) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Confirm the property is one this Google account can actually read, so a
  // crafted siteUrl can't create a link that only fails later at sync time.
  let sites;
  try {
    sites = await listSites(userId);
  } catch (err) {
    if (err instanceof GscConnectionExpiredError) {
      res.status(409).json({ error: "connection_expired", message: err.message });
      return;
    }
    throw err;
  }
  const match = sites.find((s) => s.siteUrl === siteUrl);
  if (!match) {
    res.status(404).json({ error: "property_not_found" });
    return;
  }

  // Being listed is not the same as being readable. An unverified property
  // links fine and then 403s on every sync, so refuse it here where the
  // reason is still obvious instead of at the first sync.
  if (!canReadData(match.permissionLevel)) {
    res.status(409).json({
      error: "property_unverified",
      message:
        `Google lists "${siteUrl}" for this account but ownership was never verified (${match.permissionLevel}), ` +
        "so it returns no data. Open Search Console, verify the property — for a Vercel or Netlify site the HTML tag " +
        "or file-upload method is easiest — then link it again.",
    });
    return;
  }

  const [property] = await db
    .insert(gscProperties)
    .values({
      websiteId,
      connectionId: connection.id,
      siteUrl,
      propertyType: propertyTypeOf(siteUrl),
      permissionLevel: match.permissionLevel,
    })
    .onConflictDoUpdate({
      target: gscProperties.websiteId,
      set: {
        connectionId: connection.id,
        siteUrl,
        propertyType: propertyTypeOf(siteUrl),
        permissionLevel: match.permissionLevel,
      },
    })
    .returning();

  await logAuditEvent({
    entityType: "website",
    entityId: websiteId,
    eventType: "gsc.linked",
    metadata: { siteUrl },
  });

  res.json({ property });
});

gscRouter.delete("/link/:websiteId", async (req, res) => {
  const userId = req.userId as string;
  const [website] = await db
    .select({ id: websites.id })
    .from(websites)
    .where(and(eq(websites.id, req.params.websiteId as string), eq(websites.userId, userId)));
  if (!website) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await db.delete(gscProperties).where(eq(gscProperties.websiteId, website.id));
  res.json({ unlinked: true });
});

/** Pulls the metric window for a linked website. */
gscRouter.post("/sync/:websiteId", async (req, res) => {
  await withGoogle(res, async () => {
    const result = await syncPropertyMetrics(req.userId as string, req.params.websiteId as string);
    await logAuditEvent({
      entityType: "website",
      entityId: req.params.websiteId as string,
      eventType: "gsc.synced",
      metadata: result,
    });
    res.json(result);
  });
});

/**
 * Inspects a batch of URLs against Google's index.
 *
 * Batched rather than site-wide: the URL Inspection API allows 2,000 URLs per
 * property per day, so a 1,200-page site is several runs. The response says
 * how many remain and how much quota is left, so the UI can show progress
 * instead of implying the whole site was covered.
 */
gscRouter.post("/inspect/:websiteId", async (req, res) => {
  const requested = Number((req.body as { batchSize?: number } | undefined)?.batchSize);
  // Clamped to the daily quota, not an arbitrary 500: a "Check All" button
  // that silently stops at 500 misreports what it did.
  const batchSize = Number.isFinite(requested) ? Math.min(2000, Math.max(1, requested)) : undefined;

  await withGoogle(res, async () => {
    const result = await inspectPropertyUrls(req.userId as string, req.params.websiteId as string, batchSize);
    await logAuditEvent({
      entityType: "website",
      entityId: req.params.websiteId as string,
      eventType: "gsc.inspected",
      metadata: result,
    });
    res.json(result);
  });
});

/** Queue the app's own crawler for the URLs under one Google inspection reason. */
gscRouter.post("/crawl-reason/:websiteId", async (req, res) => {
  const body = req.body as { reason?: unknown; pageUrls?: unknown } | undefined;
  const reason = body?.reason;
  // Target only an exact, stored exclusion reason. This is the app's crawler,
  // not Google's Request Indexing action.
  if (typeof reason !== "string" || reason.length === 0 || reason.length > 500) {
    res.status(400).json({ error: "unsupported_reason" });
    return;
  }

  const userId = req.userId as string;
  const [row] = await db
    .select({ website: websites, property: gscProperties })
    .from(gscProperties)
    .innerJoin(websites, eq(websites.id, gscProperties.websiteId))
    .where(and(eq(gscProperties.websiteId, req.params.websiteId as string), eq(websites.userId, userId)));
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const inspected = await db
    .select({ pageUrl: gscUrlInspections.pageUrl })
    .from(gscUrlInspections)
    .where(and(
      eq(gscUrlInspections.propertyId, row.property.id),
      eq(gscUrlInspections.coverageState, reason),
      eq(gscUrlInspections.verdict, "NEUTRAL"),
    ));
  const matchingUrls = new Set(inspected.map((item) => item.pageUrl));
  const requestedUrls = Array.isArray(body?.pageUrls)
    ? [...new Set(body.pageUrls.filter((url): url is string => typeof url === "string"))]
    : null;
  if (requestedUrls !== null && requestedUrls.length > 2_000) {
    res.status(400).json({ error: "too_many_urls", message: "A targeted crawl can include at most 2,000 URLs." });
    return;
  }
  // Intersect with the authenticated property's stored inspection rows. The
  // client may narrow the reason filter further with a URL search, but it
  // cannot use this endpoint to make the worker fetch arbitrary URLs.
  const seedUrls = (requestedUrls ?? [...matchingUrls]).filter((url) => matchingUrls.has(url)).slice(0, 2_000);
  if (seedUrls.length === 0) {
    res.status(409).json({ error: "no_matching_urls", message: "No inspected URLs match this reason." });
    return;
  }

  const allowedHosts = [...new Set(seedUrls.flatMap((url) => {
    try { return [new URL(url).hostname.toLowerCase()]; } catch { return []; }
  }))];
  if (allowedHosts.length === 0) {
    res.status(409).json({ error: "no_valid_urls", message: "The matching URLs could not be crawled." });
    return;
  }

  const [crawl] = await db
    .insert(crawls)
    .values({
      websiteId: row.website.id,
      status: "QUEUED",
      limits: {
        ...DEFAULT_CRAWL_LIMITS,
        maxPages: seedUrls.length,
        maxDepth: 0,
        allowedHosts,
        seedUrls,
      },
    })
    .returning();
  await logAuditEvent({
    entityType: "crawl",
    entityId: crawl.id,
    eventType: "crawl.targeted_from_gsc_reason",
    metadata: { reason, urls: seedUrls.length },
  });
  res.status(201).json({ crawl, urlsQueued: seedUrls.length });
});

/** Per-URL totals over the stored window, best-performing first. */
gscRouter.get("/metrics/:websiteId", async (req, res) => {
  const userId = req.userId as string;
  const [row] = await db
    .select({ property: gscProperties })
    .from(gscProperties)
    .innerJoin(websites, eq(websites.id, gscProperties.websiteId))
    .where(and(eq(gscProperties.websiteId, req.params.websiteId as string), eq(websites.userId, userId)));

  if (!row?.property) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const propertyId = row.property.id;
  const searchType = req.query.type === "image" ? "image" : "web";

  // Clamped rather than rejected: a picker sending tomorrow's date should
  // still render, with the adjustment explained.
  const range = resolveRange(req.query.start as string | undefined, req.query.end as string | undefined);

  // Pull anything the requested window doesn't already cover. No-op when it
  // does, which is the common case for the default 28 days.
  let coverageFetch;
  try {
    // Bounded. A 6-month pull paginates through many thousands of rows, and
    // an unbounded await leaves the browser spinning with no way to go back
    // to a range that is already stored. On timeout we serve what we have
    // and say it may be partial -- the fetch that timed out still completes
    // in the background, so the next request for that range is usually warm.
    coverageFetch = await Promise.race([
      ensureRangeData(req.userId as string, propertyId, row.property.siteUrl, range, searchType),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("range fetch exceeded 25s")), RANGE_FETCH_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    if (err instanceof GscConnectionExpiredError) {
      res.status(409).json({ error: "connection_expired", message: err.message });
      return;
    }
    // A live-fetch failure must not blank the page -- fall through and serve
    // whatever is already stored, flagged as possibly partial.
    console.warn("[gsc] range fetch failed, serving stored data:", err instanceof Error ? err.message : err);
    coverageFetch = { fetched: false, daysFetched: 0, rowsWritten: 0, failed: true };
  }

  // Image Search can be substantially slower on large properties. Never
  // make the default Web Search dashboard wait for it: warm its rows after
  // this response has started, then the Image search toggle is ready when
  // the user opens it. Its own request still fetches synchronously if the
  // background run has not completed yet.
  if (searchType === "web") {
    void ensureRangeData(userId, propertyId, row.property.siteUrl, range, "image").catch((err) => {
      console.warn("[gsc] background image sync failed:", err instanceof Error ? err.message : err);
    });
  }

  const inWindow = and(
    eq(gscPageMetrics.propertyId, propertyId),
    eq(gscPageMetrics.searchType, searchType),
    sql`${gscPageMetrics.date} BETWEEN ${range.startDate}::date AND ${range.endDate}::date`,
  );

  const [pages, trend, totals, breakdowns, inspections, coverage] = await Promise.all([
    db
      .select({
        pageUrl: gscPageMetrics.pageUrl,
        clicks: sql<number>`sum(${gscPageMetrics.clicks})::int`,
        impressions: sql<number>`sum(${gscPageMetrics.impressions})::int`,
        // Recomputed from the totals rather than averaging per-day CTR, which
        // would weight a 2-impression day the same as a 2000-impression one.
        ctr: sql<number>`CASE WHEN sum(${gscPageMetrics.impressions}) = 0 THEN 0
                              ELSE sum(${gscPageMetrics.clicks})::float / sum(${gscPageMetrics.impressions}) END`,
        // Position is weighted by impressions for the same reason.
        position: sql<number>`CASE WHEN sum(${gscPageMetrics.impressions}) = 0 THEN 0
                                   ELSE sum(${gscPageMetrics.position} * ${gscPageMetrics.impressions})
                                        / sum(${gscPageMetrics.impressions}) END`,
        days: sql<number>`count(*)::int`,
      })
      .from(gscPageMetrics)
      .where(inWindow)
      .groupBy(gscPageMetrics.pageUrl)
      .orderBy(desc(sql`sum(${gscPageMetrics.impressions})`))
      .limit(1000),

    // Daily totals for the trend line. `to_char` rather than the raw date
    // column: node-postgres turns a DATE into a local-midnight Date object,
    // which serialises to the *previous* day in any timezone behind UTC.
    db
      .select({
        date: sql<string>`to_char(${gscPageMetrics.date}, 'YYYY-MM-DD')`,
        clicks: sql<number>`sum(${gscPageMetrics.clicks})::int`,
        impressions: sql<number>`sum(${gscPageMetrics.impressions})::int`,
      })
      .from(gscPageMetrics)
      .where(inWindow)
      .groupBy(sql`to_char(${gscPageMetrics.date}, 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(${gscPageMetrics.date}, 'YYYY-MM-DD')`),

    db
      .select({
        clicks: sql<number>`coalesce(sum(${gscPageMetrics.clicks}), 0)::int`,
        impressions: sql<number>`coalesce(sum(${gscPageMetrics.impressions}), 0)::int`,
        ctr: sql<number>`CASE WHEN coalesce(sum(${gscPageMetrics.impressions}), 0) = 0 THEN 0
                              ELSE sum(${gscPageMetrics.clicks})::float / sum(${gscPageMetrics.impressions}) END`,
        position: sql<number>`CASE WHEN coalesce(sum(${gscPageMetrics.impressions}), 0) = 0 THEN 0
                                   ELSE sum(${gscPageMetrics.position} * ${gscPageMetrics.impressions})
                                        / sum(${gscPageMetrics.impressions}) END`,
        pages: sql<number>`count(DISTINCT ${gscPageMetrics.pageUrl})::int`,
        firstDate: sql<string | null>`to_char(min(${gscPageMetrics.date}), 'YYYY-MM-DD')`,
        lastDate: sql<string | null>`to_char(max(${gscPageMetrics.date}), 'YYYY-MM-DD')`,
      })
      .from(gscPageMetrics)
      .where(inWindow),

    db
      .select({
        dimension: gscBreakdowns.dimension,
        keyValue: gscBreakdowns.keyValue,
        clicks: gscBreakdowns.clicks,
        impressions: gscBreakdowns.impressions,
        ctr: gscBreakdowns.ctr,
        position: gscBreakdowns.position,
      })
      .from(gscBreakdowns)
      .where(
        and(
          eq(gscBreakdowns.propertyId, propertyId),
          eq(gscBreakdowns.searchType, searchType),
          eq(gscBreakdowns.windowStart, range.startDate),
          eq(gscBreakdowns.windowEnd, range.endDate),
        ),
      )
      .orderBy(desc(gscBreakdowns.impressions))
      .limit(6000),

    db
      .select({
        pageUrl: gscUrlInspections.pageUrl,
        verdict: gscUrlInspections.verdict,
        coverageState: gscUrlInspections.coverageState,
        robotsTxtState: gscUrlInspections.robotsTxtState,
        indexingState: gscUrlInspections.indexingState,
        pageFetchState: gscUrlInspections.pageFetchState,
        googleCanonical: gscUrlInspections.googleCanonical,
        userCanonical: gscUrlInspections.userCanonical,
        lastCrawlTime: gscUrlInspections.lastCrawlTime,
        crawledAs: gscUrlInspections.crawledAs,
        sitemaps: gscUrlInspections.sitemaps,
        raw: gscUrlInspections.raw,
        inspectedAt: gscUrlInspections.inspectedAt,
      })
      .from(gscUrlInspections)
      .where(eq(gscUrlInspections.propertyId, propertyId))
      // Not-indexed first: those are the rows that need action.
      .orderBy(sql`CASE ${gscUrlInspections.verdict} WHEN 'FAIL' THEN 0 WHEN 'NEUTRAL' THEN 1 WHEN 'PARTIAL' THEN 2 ELSE 3 END`)
      .limit(10000),

    // Rolled up server-side so the UI never has to count 2,000 rows to draw
    // a summary, and stays correct if the row list above is truncated.
    db
      .select({
        verdict: gscUrlInspections.verdict,
        coverageState: gscUrlInspections.coverageState,
        count: sql<number>`count(*)::int`,
      })
      .from(gscUrlInspections)
      .where(eq(gscUrlInspections.propertyId, propertyId))
      .groupBy(gscUrlInspections.verdict, gscUrlInspections.coverageState)
      .orderBy(desc(sql`count(*)`)),
  ]);

  res.json({
    property: {
      siteUrl: row.property.siteUrl,
      propertyType: row.property.propertyType,
      lastSyncedAt: row.property.lastSyncedAt,
    },
    range: { ...range, latestAvailable: latestUsableDate(), provisionalStart: provisionalStartDate(range.endDate) },
    searchType,
    fetchedLive: coverageFetch.fetched,
    partial: Boolean((coverageFetch as { failed?: boolean }).failed),
    totals: totals[0] ?? null,
    trend,
    pages,
    queries: breakdowns.filter((b) => b.dimension === "query"),
    devices: breakdowns.filter((b) => b.dimension === "device"),
    countries: breakdowns.filter((b) => b.dimension === "country"),
    searchAppearances: breakdowns.filter((b) => b.dimension === "searchAppearance"),
    inspections,
    coverage,
  });
});

const BUCKETS = ["not_indexed", "not_crawled", "indexed_traffic", "indexed_no_clicks", "crawled_no_data"] as const;

/**
 * One row per URL, merging our crawl with Search Console traffic and index
 * verdicts. The spine of the unified Site view.
 */
gscRouter.get("/urls/:websiteId", async (req, res) => {
  const userId = req.userId as string;
  const websiteId = req.params.websiteId as string;

  // Ownership first; the property is optional so a site with no Search
  // Console link still lists its crawled URLs rather than 404ing.
  const [owned] = await db
    .select({ id: websites.id })
    .from(websites)
    .where(and(eq(websites.id, websiteId), eq(websites.userId, userId)));
  if (!owned) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const [prop] = await db
    .select({ id: gscProperties.id, siteUrl: gscProperties.siteUrl })
    .from(gscProperties)
    .where(eq(gscProperties.websiteId, websiteId));

  const range = resolveRange(req.query.start as string | undefined, req.query.end as string | undefined);
  const bucket = BUCKETS.includes(req.query.bucket as Bucket) ? (req.query.bucket as Bucket) : undefined;
  const search = typeof req.query.search === "string" && req.query.search.trim() ? req.query.search.trim() : undefined;

  const limit = Number(req.query.limit) || undefined;
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const result = await getMergedUrls(websiteId, prop?.id ?? null, range, { bucket, search, limit, offset });
  res.json({ ...result, range, gscLinked: Boolean(prop), siteUrl: prop?.siteUrl ?? null });
});

gscRouter.delete("/connection", async (req, res) => {
  await disconnect(req.userId as string);
  await logAuditEvent({
    entityType: "user",
    entityId: req.userId as string,
    eventType: "gsc.disconnected",
  });
  res.json({ disconnected: true });
});

/**
 * True when the website exists and belongs to this user.
 *
 * Same shape as the inline lookups above: another user's websiteId matches
 * nothing, so the caller reports 404 -- indistinguishable from an id that
 * doesn't exist, which is the point.
 */
async function ownsWebsite(userId: string, websiteId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: websites.id })
    .from(websites)
    .where(and(eq(websites.id, websiteId), eq(websites.userId, userId)));
  return Boolean(row);
}

/**
 * Deep links into the Search Console UI for the two surfaces Google exposes
 * no API for. No resource parameter: GSC ignores unknown ones anyway, and the
 * user picks their property once inside.
 */
const GSC_UI_LINKS = {
  manualActions: "https://search.google.com/search-console/manual-actions",
  securityIssues: "https://search.google.com/search-console/security-issues",
} as const;

/** Pulls the sitemap list from Search Console into the local table. */
gscRouter.post("/sitemaps/:websiteId/sync", async (req, res) => {
  const userId = req.userId as string;
  if (!(await ownsWebsite(userId, req.params.websiteId as string))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await withGoogle(res, async () => {
    const result = await syncSitemaps(userId, req.params.websiteId as string);
    res.json(result);
  });
});

/**
 * Stored sitemaps for a website's linked property.
 *
 * An unlinked site answers `gscLinked: false` rather than 404: "no Search
 * Console link" is a state the tab renders (with a link prompt), not a
 * missing resource.
 */
gscRouter.get("/sitemaps/:websiteId", async (req, res) => {
  const userId = req.userId as string;
  const websiteId = req.params.websiteId as string;
  if (!(await ownsWebsite(userId, websiteId))) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const [prop] = await db
    .select({ id: gscProperties.id })
    .from(gscProperties)
    .where(eq(gscProperties.websiteId, websiteId));
  if (!prop) {
    res.json({ gscLinked: false, sitemaps: [], fetchedAt: null });
    return;
  }

  const rows = await db
    .select()
    .from(gscSitemaps)
    .where(eq(gscSitemaps.propertyId, prop.id))
    .orderBy(gscSitemaps.path);

  // The newest fetch stamp tells the tab how stale the whole list is; rows
  // themselves are kept across syncs even when Google drops a path.
  let fetchedAt: Date | null = null;
  for (const r of rows) {
    if (fetchedAt === null || r.fetchedAt > fetchedAt) fetchedAt = r.fetchedAt;
  }

  res.json({
    gscLinked: true,
    sitemaps: rows.map((r) => ({
      path: r.path,
      lastSubmitted: r.lastSubmitted?.toISOString() ?? null,
      lastDownloaded: r.lastDownloaded?.toISOString() ?? null,
      isPending: r.isPending,
      isSitemapsIndex: r.isSitemapsIndex,
      warnings: r.warnings,
      errors: r.errors,
      contents: r.contents ?? [],
    })),
    fetchedAt: fetchedAt?.toISOString() ?? null,
  });
});

/**
 * Runs PageSpeed Insights against the site's top pages.
 *
 * The limit is capped at 25, not the inspect route's 2,000: each PSI call is
 * a full Lighthouse run on Google's side, and the unkeyed quota is small
//  * enough that a big batch would mostly report `stoppedReason`.
 */
gscRouter.post("/cwv/:websiteId/run", async (req, res) => {
  const userId = req.userId as string;
  const websiteId = req.params.websiteId as string;
  if (!(await ownsWebsite(userId, websiteId))) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const body = req.body as { limit?: number; strategy?: string } | undefined;
  const requested = Number(body?.limit);
  const limit = Number.isFinite(requested) ? Math.min(25, Math.max(1, requested)) : 10;
  const strategy = body?.strategy === "desktop" ? "desktop" : "mobile";

  const result = await runWebVitals(websiteId, { limit, strategy });
  res.json(result);
});

/** Stored Core Web Vitals for one strategy, worst LCP first. */
gscRouter.get("/cwv/:websiteId", async (req, res) => {
  const userId = req.userId as string;
  const websiteId = req.params.websiteId as string;
  if (!(await ownsWebsite(userId, websiteId))) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const strategy = req.query.strategy === "desktop" ? "desktop" : "mobile";
  const rows = await getWebVitalsRows(websiteId, strategy);
  // ISO timestamps compare correctly as strings, so the max is the newest.
  const collectedAt = rows.reduce<string | null>(
    (max, r) => (max === null || r.collectedAt > max ? r.collectedAt : max),
    null,
  );
  res.json({ rows, collectedAt });
});

const LINK_VIEWS = ["pages", "domains", "orphans"] as const;

/**
 * Link-graph views from the latest completed crawl. Not Search Console data
 * -- Google exposes no links API -- so this works with no property linked,
 * and a site with no completed crawl gets empty rows, not an error.
 */
gscRouter.get("/links/:websiteId", async (req, res) => {
  const userId = req.userId as string;
  const websiteId = req.params.websiteId as string;
  if (!(await ownsWebsite(userId, websiteId))) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Unknown views fall back to the default rather than 400ing, matching how
  // `/urls` treats an unknown bucket.
  const view = LINK_VIEWS.includes(req.query.view as (typeof LINK_VIEWS)[number])
    ? (req.query.view as (typeof LINK_VIEWS)[number])
    : "pages";
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, requestedLimit)) : 100;
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const result = await getLinkInsights(websiteId, { view, limit, offset });
  res.json(result);
});

/** Structured-data coverage from the latest completed crawl. */
gscRouter.get("/enhancements/:websiteId", async (req, res) => {
  const userId = req.userId as string;
  const websiteId = req.params.websiteId as string;
  if (!(await ownsWebsite(userId, websiteId))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(await getEnhancements(websiteId));
});

/**
 * Mobile signals: crawl-derived viewport coverage plus the stored mobile
 * Core Web Vitals. Google retired the Mobile Usability API (Dec 2023), so
 * this is the honest substitute, and the tab's caption says so.
 */
gscRouter.get("/mobile/:websiteId", async (req, res) => {
  const userId = req.userId as string;
  const websiteId = req.params.websiteId as string;
  if (!(await ownsWebsite(userId, websiteId))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const [usability, cwv] = await Promise.all([getMobileUsability(websiteId), getWebVitalsRows(websiteId, "mobile")]);
  res.json({ ...usability, cwv });
  
});
/** Latest Safe Browsing verdict, plus links to the GSC surfaces with no API. */
gscRouter.get("/security/:websiteId", async (req, res) => {
  const userId = req.userId as string;
  const websiteId = req.params.websiteId as string;
  if (!(await ownsWebsite(userId, websiteId))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const status = await getSecurityStatus(websiteId);
  res.json({ ...status, gscLinks: GSC_UI_LINKS });
});

/** Runs a fresh Safe Browsing check and returns the new verdict. */
gscRouter.post("/security/:websiteId/check", async (req, res) => {
  const userId = req.userId as string;
  const websiteId = req.params.websiteId as string;
  if (!(await ownsWebsite(userId, websiteId))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const result = await checkSite(websiteId);
  res.json({ ...result, gscLinks: GSC_UI_LINKS });
});

/**
 * "Why pages aren't indexed", in Search Console's own Reason / Source / Pages
 * shape.
 *
 * The Website-source reasons are computed from the latest completed crawl, so
 * this works with no property linked; the Google-systems reasons need stored
 * URL Inspection rows and come back `available: false` without them. No
 * crawl at all is an empty report, not an error -- the tab renders an empty
 * state, matching /links and /enhancements.
 */
gscRouter.get("/coverage/:websiteId", async (req, res) => {
  const userId = req.userId as string;
  const websiteId = req.params.websiteId as string;
  if (!(await ownsWebsite(userId, websiteId))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(await getCoverage(websiteId));
});
