import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { gscBreakdowns, gscPageMetrics, gscProperties, websites } from "../db/schema.js";
import { querySearchAnalytics } from "./client.js";
import { toJoinKey } from "./joinKey.js";

/**
 * Days of history pulled by default.
 *
 * 28 matches the window Search Console's own UI defaults to, keeps a first
 * sync to one or two API requests, and is long enough for a before/after
 * comparison around a shipped fix. Override with GSC_SYNC_DAYS.
 */
const DEFAULT_SYNC_DAYS = 28;

/**
 * Search Console data is not final for roughly two to three days. Ending the
 * window before then means stored rows are settled figures rather than
 * provisional ones that quietly change later.
 */
const DATA_LAG_DAYS = 3;

/** Ceiling on rows per sync, so one enormous property can't run unbounded. */
const MAX_ROWS = 100_000;

/**
 * Rows kept per breakdown dimension.
 *
 * Search Analytics returns queries in descending clicks, so the head of the
 * list carries essentially all the actionable signal -- the tail is
 * single-impression long-tail noise. Device and country never approach this.
 */
const MAX_BREAKDOWN_ROWS = 5_000;

const BREAKDOWN_DIMENSIONS = ["query", "device", "country"] as const;
type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

export interface SyncResult extends Record<string, unknown> {
  siteUrl: string;
  startDate: string;
  endDate: string;
  rowsFetched: number;
  rowsWritten: number;
  /** Distinct URLs seen in this window. */
  pages: number;
  totalClicks: number;
  totalImpressions: number;
  /** Rows written per non-page dimension, e.g. { query: 812, device: 3 }. */
  breakdowns: Record<string, number>;
}

/**
 * Pulls per-page, per-day search metrics for one linked property.
 *
 * Requesting `["date", "page"]` rather than page-only is deliberate: daily
 * granularity is what makes "clicks before the fix vs clicks after" possible.
 * A page-only aggregate would be smaller but could never answer that, which
 * is the entire reason for connecting Search Console.
 *
 * Idempotent -- re-syncing an overlapping window updates the days it covers
 * instead of duplicating them.
 */
export async function syncPropertyMetrics(userId: string, websiteId: string): Promise<SyncResult> {
  // Ownership is part of the query, not a separate check: a websiteId
  // belonging to another user simply matches no row.
  const [row] = await db
    .select({ property: gscProperties })
    .from(gscProperties)
    .innerJoin(websites, eq(websites.id, gscProperties.websiteId))
    .where(and(eq(gscProperties.websiteId, websiteId), eq(websites.userId, userId)));

  const property = row?.property;
  if (!property) throw new Error("No Search Console property is linked to this website.");

  const days = Number(process.env.GSC_SYNC_DAYS) || DEFAULT_SYNC_DAYS;
  const { startDate, endDate } = dateWindow(days);

  const rows = await querySearchAnalytics(userId, {
    siteUrl: property.siteUrl,
    startDate,
    endDate,
    dimensions: ["date", "page"],
    maxRows: MAX_ROWS,
  });

  let rowsWritten = 0;
  let totalClicks = 0;
  let totalImpressions = 0;
  const pages = new Set<string>();

  const values = rows.flatMap((r) => {
    const [date, pageUrl] = r.keys;
    // Defensive: a row missing either dimension can't be keyed or upserted.
    if (!date || !pageUrl) return [];
    pages.add(pageUrl);
    totalClicks += r.clicks;
    totalImpressions += r.impressions;
    return [{
      propertyId: property.id,
      pageUrl,
      normalizedUrl: toJoinKey(pageUrl),
      date,
      clicks: Math.round(r.clicks),
      impressions: Math.round(r.impressions),
      ctr: r.ctr,
      position: r.position,
    }];
  });

  // Chunked: Postgres caps a statement at 65535 bind parameters, and seven
  // columns per row means ~9000 rows would hit it.
  const CHUNK = 1000;
  for (let i = 0; i < values.length; i += CHUNK) {
    const written = await db
      .insert(gscPageMetrics)
      .values(values.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [gscPageMetrics.propertyId, gscPageMetrics.pageUrl, gscPageMetrics.date],
        set: {
          clicks: sql`excluded.clicks`,
          impressions: sql`excluded.impressions`,
          ctr: sql`excluded.ctr`,
          position: sql`excluded.position`,
          fetchedAt: new Date(),
        },
      })
      .returning({ id: gscPageMetrics.id });
    rowsWritten += written.length;
  }

  // Queries, devices and countries. Sequential rather than parallel: these
  // hit the same per-property rate limit as the page pull, and three extra
  // requests spread out cost nothing next to one 429 and its backoff.
  const breakdowns: Record<string, number> = {};
  for (const dimension of BREAKDOWN_DIMENSIONS) {
    breakdowns[dimension] = await syncBreakdown(userId, property.id, property.siteUrl, dimension, startDate, endDate);
  }

  await db
    .update(gscProperties)
    .set({ lastSyncedAt: new Date() })
    .where(eq(gscProperties.id, property.id));

  return {
    siteUrl: property.siteUrl,
    startDate,
    endDate,
    rowsFetched: rows.length,
    rowsWritten,
    pages: pages.size,
    totalClicks,
    totalImpressions,
    breakdowns,
  };
}

/**
 * Pulls one non-page dimension, aggregated across the whole window.
 *
 * No `date` dimension here by design -- see the note on `gscBreakdowns`. That
 * also means one API request instead of one per day, which is what keeps a
 * full sync to four calls regardless of how long the window is.
 */
async function syncBreakdown(
  userId: string,
  propertyId: string,
  siteUrl: string,
  dimension: BreakdownDimension,
  startDate: string,
  endDate: string,
): Promise<number> {
  const rows = await querySearchAnalytics(userId, {
    siteUrl,
    startDate,
    endDate,
    dimensions: [dimension],
    maxRows: MAX_BREAKDOWN_ROWS,
  });

  const values = rows.flatMap((r) => {
    const keyValue = r.keys[0];
    if (!keyValue) return [];
    return [{
      propertyId,
      dimension,
      keyValue,
      windowStart: startDate,
      windowEnd: endDate,
      clicks: Math.round(r.clicks),
      impressions: Math.round(r.impressions),
      ctr: r.ctr,
      position: r.position,
    }];
  });

  let written = 0;
  const CHUNK = 1000;
  for (let i = 0; i < values.length; i += CHUNK) {
    const result = await db
      .insert(gscBreakdowns)
      .values(values.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [
          gscBreakdowns.propertyId,
          gscBreakdowns.dimension,
          gscBreakdowns.keyValue,
          gscBreakdowns.windowStart,
          gscBreakdowns.windowEnd,
        ],
        set: {
          clicks: sql`excluded.clicks`,
          impressions: sql`excluded.impressions`,
          ctr: sql`excluded.ctr`,
          position: sql`excluded.position`,
          fetchedAt: new Date(),
        },
      })
      .returning({ id: gscBreakdowns.id });
    written += result.length;
  }

  return written;
}

/** UTC throughout: Search Console reports in UTC days, not the server's zone. */
function dateWindow(days: number): { startDate: string; endDate: string } {
  const end = new Date(Date.now() - DATA_LAG_DAYS * 86_400_000);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { startDate: iso(start), endDate: iso(end) };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Infers the property type from the string Search Console reports.
 *
 * Domain properties are addressed as `sc-domain:example.com`; everything else
 * is a URL-prefix property. The two are not interchangeable in API calls, so
 * the distinction is recorded at link time rather than guessed at each use.
 */
export function propertyTypeOf(siteUrl: string): "domain" | "url_prefix" {
  return siteUrl.startsWith("sc-domain:") ? "domain" : "url_prefix";
}

/**
 * Whether a Search Console property plausibly covers a crawled domain.
 *
 * Used to sort the picker so the obvious match is first; it never blocks a
 * link, because legitimate pairings exist that no string comparison would
 * accept (a property registered on `www.` for a site crawled bare, a
 * multi-brand property, a staging host).
 */
export function matchesDomain(siteUrl: string, domain: string): boolean {
  const bare = domain.replace(/^www\./i, "").toLowerCase();
  if (siteUrl.startsWith("sc-domain:")) {
    return siteUrl.slice("sc-domain:".length).toLowerCase() === bare;
  }
  try {
    return new URL(siteUrl).hostname.replace(/^www\./i, "").toLowerCase() === bare;
  } catch {
    return false;
  }
}
