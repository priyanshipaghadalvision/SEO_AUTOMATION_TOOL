import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { gscBreakdowns, gscPageMetrics } from "../db/schema.js";
import { querySearchAnalytics } from "./client.js";
import { toJoinKey } from "./joinKey.js";
import type { DateRange } from "./dateRange.js";
import { daysBetween, latestUsableDate, provisionalStartDate } from "./dateRange.js";

/**
 * Makes sure the stored data actually covers a requested date range,
 * fetching from Google only for what is missing.
 *
 * The alternative designs are both worse. Serving whatever happens to be
 * stored means a date picker silently lies -- ask for March, get an empty
 * chart, conclude the site had no traffic. Re-fetching on every view wastes
 * seconds and API calls re-downloading days that never change once settled.
 *
 * Search Analytics has no per-day quota worth worrying about (unlike URL
 * Inspection's 2,000/day), so an on-demand fetch is cheap; the only real cost
 * is latency, which is why coverage is checked first.
 */

const MAX_ROWS = 100_000;
const MAX_BREAKDOWN_ROWS = 5_000;
const BREAKDOWN_DIMENSIONS = ["query", "device", "country", "searchAppearance"] as const;
export type SearchType = "web" | "image";

export interface CoverageResult {
  /** True when Google had to be called. */
  fetched: boolean;
  daysFetched: number;
  rowsWritten: number;
}

/**
 * Whether every day in the range already has stored rows.
 *
 * Counts *distinct dates present*, not rows: a day where the site got no
 * impressions legitimately has zero rows, so a naive "are there rows for
 * every date" check would re-fetch such days forever. Comparing the stored
 * span against the requested span tolerates genuinely empty days inside it.
 */
async function isCovered(propertyId: string, range: DateRange, searchType: SearchType): Promise<boolean> {
  const { rows } = await db.execute<{ first: string | null; last: string | null }>(sql`
    SELECT to_char(min(date), 'YYYY-MM-DD') AS first,
           to_char(max(date), 'YYYY-MM-DD') AS last
    FROM gsc_page_metrics
    WHERE property_id = ${propertyId} AND search_type = ${searchType}::gsc_search_type
  `);
  const first = rows[0]?.first;
  const last = rows[0]?.last;
  if (!first || !last) return false;
  return first <= range.startDate && last >= range.endDate;
}

/**
 * Guarantees page-level rows and this window's breakdowns exist for `range`.
 *
 * Page metrics are stored per day and upserted, so re-fetching an overlapping
 * span is harmless. Breakdowns are stored per window -- keyed by
 * (dimension, keyValue, windowStart, windowEnd) -- so each distinct range the
 * user picks gets its own aggregate rather than overwriting another's.
 */
export async function ensureRangeData(
  userId: string,
  propertyId: string,
  siteUrl: string,
  range: DateRange,
  searchType: SearchType,
): Promise<CoverageResult> {
  // `dataState: all` intentionally includes fresh, restatable days. Refresh
  // a range touching those days even when it is already stored, otherwise a
  // page view would freeze yesterday's preliminary figure forever.
  const touchesProvisionalData = range.endDate >= provisionalStartDate(latestUsableDate());
  const needsPages = !(await isCovered(propertyId, range, searchType)) || touchesProvisionalData;
  const [{ n: haveBreakdowns }] = (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(gscBreakdowns)
      .where(
        and(
          eq(gscBreakdowns.propertyId, propertyId),
          eq(gscBreakdowns.searchType, searchType),
          eq(gscBreakdowns.windowStart, range.startDate),
          eq(gscBreakdowns.windowEnd, range.endDate),
        ),
      )
  ) as [{ n: number }];

  if (!needsPages && haveBreakdowns >= BREAKDOWN_DIMENSIONS.length) {
    return { fetched: false, daysFetched: 0, rowsWritten: 0 };
  }

  let rowsWritten = 0;

  if (needsPages) {
    const rows = await querySearchAnalytics(userId, {
      siteUrl, startDate: range.startDate, endDate: range.endDate,
      dimensions: ["date", "page"], searchType, maxRows: MAX_ROWS,
    });

    const values = rows.flatMap((r) => {
      const [date, pageUrl] = r.keys;
      if (!date || !pageUrl) return [];
      return [{ propertyId, pageUrl, normalizedUrl: toJoinKey(pageUrl), date, searchType, clicks: Math.round(r.clicks), impressions: Math.round(r.impressions), ctr: r.ctr, position: r.position }];
    });

    const CHUNK = 1000;
    for (let i = 0; i < values.length; i += CHUNK) {
      const written = await db.insert(gscPageMetrics).values(values.slice(i, i + CHUNK)).onConflictDoUpdate({
        target: [gscPageMetrics.propertyId, gscPageMetrics.pageUrl, gscPageMetrics.date, gscPageMetrics.searchType],
        set: { normalizedUrl: sql`excluded.normalized_url`, clicks: sql`excluded.clicks`, impressions: sql`excluded.impressions`, ctr: sql`excluded.ctr`, position: sql`excluded.position`, fetchedAt: new Date() },
      }).returning({ id: gscPageMetrics.id });
      rowsWritten += written.length;
    }
  }

  if (touchesProvisionalData || haveBreakdowns < BREAKDOWN_DIMENSIONS.length) {
    for (const dimension of BREAKDOWN_DIMENSIONS) {
      const rows = await querySearchAnalytics(userId, {
        siteUrl,
        startDate: range.startDate,
        endDate: range.endDate,
        dimensions: [dimension],
        searchType,
        maxRows: MAX_BREAKDOWN_ROWS,
      });

      const values = rows.flatMap((r) => {
        const keyValue = r.keys[0];
        if (!keyValue) return [];
        return [{
          propertyId,
          dimension,
          searchType,
          keyValue,
          windowStart: range.startDate,
          windowEnd: range.endDate,
          clicks: Math.round(r.clicks),
          impressions: Math.round(r.impressions),
          ctr: r.ctr,
          position: r.position,
        }];
      });

      const CHUNK = 1000;
      for (let i = 0; i < values.length; i += CHUNK) {
        const written = await db
          .insert(gscBreakdowns)
          .values(values.slice(i, i + CHUNK))
          .onConflictDoUpdate({
            target: [
              gscBreakdowns.propertyId,
              gscBreakdowns.dimension,
              gscBreakdowns.searchType,
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
        rowsWritten += written.length;
      }
    }
  }

  return { fetched: true, daysFetched: daysBetween(range), rowsWritten };
}
