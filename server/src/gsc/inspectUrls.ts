import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { gscInspectionAttempts, gscProperties, gscUrlInspections, websites } from "../db/schema.js";
import { GscApiError, inspectUrl } from "./client.js";
import { toJoinKey } from "./joinKey.js";

/**
 * Google's published ceiling: 2,000 inspections per property per day.
 *
 * Enforced on our side as well as Google's, because hitting it server-side
 * returns a 429 that is indistinguishable from ordinary rate limiting -- and
 * retrying that only burns the next day's allowance too.
 */
const DAILY_QUOTA = 2_000;

/** URLs per run. Small enough to stay interactive, large enough to progress. */
const DEFAULT_BATCH = 50;

/**
 * How long an inspection stays fresh. Re-inspecting a URL that Google looked
 * at two days ago wastes quota that an uninspected URL could use.
 */
const RECHECK_AFTER_DAYS = 7;

/**
 * URLs inspected in parallel.
 *
 * Measured: a single inspection takes about 7 seconds, so serial execution
 * runs at ~8 URLs/minute -- a 500-page site would take an hour of wall-clock
 * and no HTTP request survives that. Five in flight brings it to roughly
 * 40/minute while staying far inside Google's 600/minute ceiling, since each
 * worker only manages ~8 calls a minute.
 */
const CONCURRENCY = 5;

/** Pause between a worker's calls, so a fast response can't bunch up. */
const THROTTLE_MS = 120;

export interface InspectionRunResult extends Record<string, unknown> {
  inspected: number;
  failed: number;
  /** URLs still never inspected, or older than the recheck window. */
  remaining: number;
  quotaUsedToday: number;
  quotaRemainingToday: number;
  /** Set when the run stopped early rather than finishing its batch. */
  stoppedReason: string | null;
  /**
   * Google refused on quota while our meter still showed budget. When true
   * the UI must trust Google and stop advertising a remaining figure.
   */
  quotaDisagreement: boolean;
  byVerdict: Record<string, number>;
}

type Verdict = "PASS" | "PARTIAL" | "FAIL" | "NEUTRAL" | "VERDICT_UNSPECIFIED";

const VERDICTS: Verdict[] = ["PASS", "PARTIAL", "FAIL", "NEUTRAL", "VERDICT_UNSPECIFIED"];
const toVerdict = (v: string | undefined): Verdict =>
  VERDICTS.includes(v as Verdict) ? (v as Verdict) : "VERDICT_UNSPECIFIED";

/**
 * Inspects a batch of this property's URLs, highest-value first.
 *
 * Priority is impressions descending, then URLs we crawled but Google has
 * never sent traffic to. That ordering is deliberate: a page with traffic
 * being quietly dropped from the index is an emergency, while a zero-traffic
 * page that was never indexed is the more common question -- and both get
 * answered before the long tail of pages nobody visits. Crawl URLs include
 * redirects and error responses too: those are exactly the excluded URLs the
 * Page Indexing report counts, so restricting this to successful pages makes
 * a "Check All" result systematically smaller than Search Console.
 */
export async function inspectPropertyUrls(
  userId: string,
  websiteId: string,
  batchSize = DEFAULT_BATCH,
): Promise<InspectionRunResult> {
  const [row] = await db
    .select({ property: gscProperties })
    .from(gscProperties)
    .innerJoin(websites, eq(websites.id, gscProperties.websiteId))
    .where(and(eq(gscProperties.websiteId, websiteId), eq(websites.userId, userId)));

  const property = row?.property;
  if (!property) throw new Error("No Search Console property is linked to this website.");

  const quotaUsedToday = await countInspectionsToday(property.id);
  const quotaLeft = Math.max(0, DAILY_QUOTA - quotaUsedToday);
  if (quotaLeft === 0) {
    return {
      inspected: 0,
      failed: 0,
      remaining: await countPending(property.id, websiteId),
      quotaUsedToday,
      quotaRemainingToday: 0,
      stoppedReason: `Daily quota of ${DAILY_QUOTA} URL inspections for this property is spent. It resets at midnight Pacific time.`,
      quotaDisagreement: false,
      byVerdict: {},
    };
  }

  const limit = Math.min(batchSize, quotaLeft);
  const candidates = await selectCandidates(property.id, websiteId, limit);

  let inspected = 0;
  let failed = 0;
  let stoppedReason: string | null = null;
  /** True when Google rejected on quota while our own meter still had budget. */
  let quotaDisagreement = false;
  const byVerdict: Record<string, number> = {};

  // Workers pull from a shared cursor rather than taking fixed slices, so a
  // slow URL never leaves the others idle behind it.
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (stoppedReason !== null) return; // Quota exhausted; stop the whole run.
      const index = cursor++;
      if (index >= candidates.length) return;
      const pageUrl = candidates[index] as string;
      await inspectOne(pageUrl);
      await sleep(THROTTLE_MS);
    }
  }

  /** Meters one API call. Must run for failures too -- Google charges for them. */
  async function recordAttempt(succeeded: boolean): Promise<void> {
    await db.insert(gscInspectionAttempts).values({ propertyId: property!.id, succeeded });
  }

  async function inspectOne(pageUrl: string): Promise<void> {
    try {
      const result = await inspectUrl(userId, property!.siteUrl, pageUrl);
      await recordAttempt(true);
      const status = result.indexStatusResult ?? {};
      const verdict = toVerdict(status.verdict);
      const raw = {
        inspectionResultLink: result.inspectionResultLink ?? null,
        referringUrls: status.referringUrls ?? [],
        richResults: result.richResultsResult ?? null,
        amp: result.ampResult ?? null,
        mobileUsability: result.mobileUsabilityResult ?? null,
      };

      await db
        .insert(gscUrlInspections)
        .values({
          propertyId: property!.id,
          pageUrl,
          normalizedUrl: toJoinKey(pageUrl),
          verdict,
          coverageState: status.coverageState ?? null,
          robotsTxtState: status.robotsTxtState ?? null,
          indexingState: status.indexingState ?? null,
          pageFetchState: status.pageFetchState ?? null,
          googleCanonical: status.googleCanonical ?? null,
          userCanonical: status.userCanonical ?? null,
          lastCrawlTime: status.lastCrawlTime ? new Date(status.lastCrawlTime) : null,
          crawledAs: status.crawledAs ?? null,
          sitemaps: status.sitemap ?? null,
          raw,
          inspectedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [gscUrlInspections.propertyId, gscUrlInspections.pageUrl],
          set: {
            normalizedUrl: toJoinKey(pageUrl),
            verdict,
            coverageState: status.coverageState ?? null,
            robotsTxtState: status.robotsTxtState ?? null,
            indexingState: status.indexingState ?? null,
            pageFetchState: status.pageFetchState ?? null,
            googleCanonical: status.googleCanonical ?? null,
            userCanonical: status.userCanonical ?? null,
            lastCrawlTime: status.lastCrawlTime ? new Date(status.lastCrawlTime) : null,
            crawledAs: status.crawledAs ?? null,
            sitemaps: status.sitemap ?? null,
            raw,
            inspectedAt: new Date(),
          },
        });

      inspected += 1;
      byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1;
    } catch (err) {
      // A 429 here means the allowance is gone. Continuing would fail every
      // remaining URL identically and, on some accounts, dig into tomorrow's
      // quota -- so the run stops and says why.
      await recordAttempt(false);
      if (err instanceof GscApiError && err.status === 429) {
        // Setting this stops every worker, not just this one -- the quota is
        // per property, so the others would fail identically.
        // Google is the authority on quota, not our meter. Say so plainly
        // rather than printing a "remaining" figure that Google disagrees
        // with -- the two contradicting each other on screen is worse than
        // admitting the estimate was wrong.
        quotaDisagreement = true;
        stoppedReason =
          "Google says the daily allowance for this property is spent, even though our own count had budget left. " +
          "Google counts every API call including failures, so treat its answer as the real one and retry after midnight Pacific.";
        return;
      }
      failed += 1;
      console.error(`[gsc] inspect failed for ${pageUrl}:`, err instanceof Error ? err.message : err);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));

  const used = quotaUsedToday + inspected;
  return {
    inspected,
    failed,
    remaining: await countPending(property.id, websiteId),
    quotaUsedToday: used,
    quotaRemainingToday: Math.max(0, DAILY_QUOTA - used),
    stoppedReason,
    quotaDisagreement,
    // Google's refusal overrides our arithmetic -- claiming budget remains
    // after it said otherwise is the contradiction this whole fix removes.
    ...(quotaDisagreement ? { quotaRemainingToday: 0 } : {}),
    byVerdict,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Picks the next URLs to inspect.
 *
 * The candidate pool is the union of two sources -- URLs Search Console has
 * impressions for, and URLs our own crawler found. The second half is the
 * important one: a page the crawler reached but Google has never shown is
 * exactly the page whose indexing status is worth asking about, and it would
 * be invisible if the pool came from Search Console alone.
 */
async function selectCandidates(propertyId: string, websiteId: string, limit: number): Promise<string[]> {
  const { rows } = await db.execute<{ page_url: string }>(sql`
    WITH candidates AS (
      SELECT m.page_url, sum(m.impressions)::int AS impressions
      FROM gsc_page_metrics m
      WHERE m.property_id = ${propertyId}
      GROUP BY m.page_url

      UNION

      -- Inspect the requested URL, not its final redirect destination. Google
      -- reports a redirect source as an excluded URL in its own right.
      SELECT p.url AS page_url, 0 AS impressions
      FROM pages p
      JOIN crawls c ON c.id = p.crawl_id
      WHERE c.website_id = ${websiteId}
    )
    SELECT c.page_url,
           max(c.impressions) AS impressions
    FROM candidates c
    LEFT JOIN gsc_url_inspections i
      ON i.property_id = ${propertyId} AND i.page_url = c.page_url
    WHERE i.id IS NULL
       OR i.inspected_at < now() - (${RECHECK_AFTER_DAYS} || ' days')::interval
    GROUP BY c.page_url
    ORDER BY max(c.impressions) DESC, c.page_url
    LIMIT ${limit}
  `);
  return rows.map((r) => r.page_url);
}

/** URLs never inspected, or due a re-check. */
async function countPending(propertyId: string, websiteId: string): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`
    WITH candidates AS (
      SELECT DISTINCT m.page_url FROM gsc_page_metrics m WHERE m.property_id = ${propertyId}
      UNION
      -- Keep non-2xx URLs and redirect sources for the same reason as the
      -- candidate query above: they are valid URL Inspection targets and are
      -- part of Google's excluded-page total.
      SELECT DISTINCT p.url FROM pages p
      JOIN crawls c ON c.id = p.crawl_id
      WHERE c.website_id = ${websiteId}
    )
    SELECT count(*)::int AS n
    FROM candidates c
    LEFT JOIN gsc_url_inspections i
      ON i.property_id = ${propertyId} AND i.page_url = c.page_url
    WHERE i.id IS NULL
       OR i.inspected_at < now() - (${RECHECK_AFTER_DAYS} || ' days')::interval
  `);
  return rows[0]?.n ?? 0;
}

/**
 * Inspections already spent today.
 *
 * Counted in America/Los_Angeles because that is when Google's quota resets,
 * not at the server's local midnight.
 */
async function countInspectionsToday(propertyId: string): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM gsc_inspection_attempts
    WHERE property_id = ${propertyId}
      AND (attempted_at AT TIME ZONE 'America/Los_Angeles')::date
          = (now() AT TIME ZONE 'America/Los_Angeles')::date
  `);
  return rows[0]?.n ?? 0;
}
