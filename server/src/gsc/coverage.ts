import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

/**
 * "Why pages aren't indexed" -- Google's coverage report, rebuilt from our own
 * crawl.
 *
 * Search Console splits that report by Source. A "Website" reason is a
 * condition the site itself creates (a noindex tag, a 404, a canonical
 * pointing elsewhere) and is therefore fully computable from a crawl. A
 * "Google systems" reason is a judgement only Google can make ("we fetched it
 * and decided not to index it"), and the only API that reveals it is URL
 * Inspection -- 2,000 URLs per property per day.
 *
 * So the seven Website reasons come from `pages`, and the three Google ones
 * come from stored `gsc_url_inspections` rows. When no inspections exist the
 * Google rows are returned with `available: false` rather than a zero count:
 * "we haven't asked Google" and "Google says none" are different answers, and
 * showing the second when the first is true would be a lie the UI can't undo.
 *
 * Read-only. No writes, no DDL.
 */

export interface CoverageReasonRow {
  reason: string;
  source: "Website" | "Google systems";
  pages: number;
  /** False when the data needed to answer this reason has not been collected. */
  available: boolean;
  /** At most 5. */
  sampleUrls: string[];
  detail: string;
}

export interface CoverageResult {
  crawlId: string | null;
  crawledAt: string | null;
  totalCrawled: number;
  indexableCount: number;
  reasons: CoverageReasonRow[];
  googleReasons: CoverageReasonRow[];
  /** Stored inspection rows for the linked property; 0 means the Google rows are unanswered. */
  inspectionsAvailable: number;
}

/** Google's own wording, so the table reads the same as the report it mirrors. */
const R_NOINDEX = "Excluded by 'noindex' tag";
const R_REDIRECT = "Page with redirect";
const R_403 = "Blocked due to access forbidden (403)";
const R_404 = "Not found (404)";
const R_5XX = "Server error (5xx)";
const R_ALT_CANONICAL = "Alternative page with proper canonical tag";
const R_DUP_NO_CANONICAL = "Duplicate without user-selected canonical";

const R_CRAWLED_NOT_INDEXED = "Crawled - currently not indexed";
const R_DISCOVERED_NOT_INDEXED = "Discovered - currently not indexed";
const R_GOOGLE_CANONICAL = "Duplicate, Google chose different canonical than user";

/**
 * Match on the distinctive words rather than the full sentence: Google has
 * changed the punctuation of these strings before (the dash in
 * "Crawled - currently not indexed" is not stable across locales/exports),
 * and an exact match would silently drop every row when it changes again.
 */
const GOOGLE_PATTERNS: Record<string, string> = {
  [R_CRAWLED_NOT_INDEXED]: "%crawled%currently not indexed%",
  [R_DISCOVERED_NOT_INDEXED]: "%discovered%currently not indexed%",
  [R_GOOGLE_CANONICAL]: "%duplicate%google chose%",
};

const DETAILS: Record<string, string> = {
  [R_NOINDEX]:
    "These pages carry a noindex directive in their meta robots tag or X-Robots-Tag header, so Google drops them on purpose -- remove the directive from any page you actually want in search.",
  [R_REDIRECT]:
    "These URLs answer with a 3xx redirect, so Google indexes the destination instead -- point internal links and your sitemap straight at the final URL.",
  [R_403]:
    "The server refused these requests with a 403, so Googlebot never saw the content -- check for firewall, geo-blocking or login rules that catch Google's crawler.",
  [R_404]:
    "These URLs return 404, so Google removes them from the index -- restore the page or redirect it to the closest live equivalent.",
  [R_5XX]:
    "The server errored on these URLs; Google retries for a while and then stops -- fix the error before the pages fall out of the index.",
  [R_ALT_CANONICAL]:
    "These pages name a different URL as canonical, so Google indexes that one instead -- correct behaviour for variants and duplicates, a problem when the canonical target is wrong.",
  [R_DUP_NO_CANONICAL]:
    "These pages have byte-identical content to another crawled page and declare no canonical, so Google picks the winner for you -- add a canonical tag to make the choice yourself.",
  [R_CRAWLED_NOT_INDEXED]:
    "Google fetched these pages and decided not to index them, which is usually a content-quality or thin-content judgement -- strengthen the page and the internal links pointing at it.",
  [R_DISCOVERED_NOT_INDEXED]:
    "Google knows these URLs exist but has not crawled them yet, typically a crawl-budget or server-response-time limit -- speed the site up and link to them from stronger pages.",
  [R_GOOGLE_CANONICAL]:
    "Google overrode your canonical tag and picked a different URL as the original -- confirm the two pages really are duplicates and consolidate them if they are.",
};

/** pages DESC, then reason, so the biggest problem is always the first row. */
function byPagesThenReason(a: CoverageReasonRow, b: CoverageReasonRow): number {
  return b.pages - a.pages || a.reason.localeCompare(b.reason);
}

function websiteRow(reason: string, pages: number, sampleUrls: string[] | null): CoverageReasonRow {
  return {
    reason,
    source: "Website",
    pages,
    // Always answerable: the crawl either found such pages or proved there are none.
    available: true,
    sampleUrls: sampleUrls ?? [],
    detail: DETAILS[reason] as string,
  };
}

type CoverageAgg = {
  total_crawled: number;
  indexable: number;
  n_noindex: number;
  s_noindex: string[] | null;
  n_redirect: number;
  s_redirect: string[] | null;
  n_403: number;
  s_403: string[] | null;
  n_404: number;
  s_404: string[] | null;
  n_5xx: number;
  s_5xx: string[] | null;
  n_alt_canonical: number;
  s_alt_canonical: string[] | null;
  n_dup_no_canonical: number;
  s_dup_no_canonical: string[] | null;
};

const EMPTY_AGG: CoverageAgg = {
  total_crawled: 0,
  indexable: 0,
  n_noindex: 0,
  s_noindex: null,
  n_redirect: 0,
  s_redirect: null,
  n_403: 0,
  s_403: null,
  n_404: 0,
  s_404: null,
  n_5xx: 0,
  s_5xx: null,
  n_alt_canonical: 0,
  s_alt_canonical: null,
  n_dup_no_canonical: 0,
  s_dup_no_canonical: null,
};

export async function getCoverage(websiteId: string): Promise<CoverageResult> {
  // Latest COMPLETED crawl -- the enum is uppercase, and a lowercase literal
  // matches nothing rather than erroring. NULLS LAST because DESC would
  // otherwise float a crawl with no start stamp above every real one.
  // Formatted in SQL, not JS: `db.execute` hands raw driver output back, and
  // a timestamptz arrives as "2026-08-12 06:44:56.046+00" -- not the ISO
  // string every other endpoint emits, and not something `new Date()` is
  // required to parse.
  const { rows: crawlRows } = await db.execute<{ id: string; crawled_at: string | null }>(sql`
    SELECT c.id,
           to_char(COALESCE(c.finished_at, c.started_at) AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS crawled_at
    FROM crawls c
    WHERE c.website_id = ${websiteId}::uuid AND c.status = 'COMPLETED'
    ORDER BY c.started_at DESC NULLS LAST, c.created_at DESC
    LIMIT 1
  `);
  const crawlId = crawlRows[0]?.id ?? null;
  const crawledAt = crawlRows[0]?.crawled_at ?? null;

  // The Google side does not depend on a crawl, so it is resolved either way:
  // a site with no crawl still deserves the "run an inspection" explanation
  // rather than a blank panel.
  const { rows: propRows } = await db.execute<{ id: string }>(sql`
    SELECT id FROM gsc_properties WHERE website_id = ${websiteId}::uuid LIMIT 1
  `);
  const propertyId = propRows[0]?.id ?? null;

  const [agg, googleReasons, inspectionsAvailable] = await Promise.all([
    crawlId === null ? Promise.resolve(EMPTY_AGG) : aggregateCrawl(crawlId),
    googleSystemReasons(propertyId),
    countInspections(propertyId),
  ]);

  const reasons: CoverageReasonRow[] = [
    websiteRow(R_NOINDEX, Number(agg.n_noindex ?? 0), agg.s_noindex),
    websiteRow(R_REDIRECT, Number(agg.n_redirect ?? 0), agg.s_redirect),
    websiteRow(R_403, Number(agg.n_403 ?? 0), agg.s_403),
    websiteRow(R_404, Number(agg.n_404 ?? 0), agg.s_404),
    websiteRow(R_5XX, Number(agg.n_5xx ?? 0), agg.s_5xx),
    websiteRow(R_ALT_CANONICAL, Number(agg.n_alt_canonical ?? 0), agg.s_alt_canonical),
    websiteRow(R_DUP_NO_CANONICAL, Number(agg.n_dup_no_canonical ?? 0), agg.s_dup_no_canonical),
  ].sort(byPagesThenReason);

  return {
    crawlId,
    crawledAt,
    totalCrawled: Number(agg.total_crawled ?? 0),
    indexableCount: Number(agg.indexable ?? 0),
    reasons,
    // With nothing inspected, every Google row is unanswered rather than
    // clean -- the count and the availability flag have to agree.
    googleReasons: googleReasons
      .map((r) => (inspectionsAvailable > 0 ? r : { ...r, pages: 0, sampleUrls: [], available: false }))
      .sort(byPagesThenReason),
    inspectionsAvailable,
  };
}

/**
 * All seven Website reasons in one pass over the crawl's pages.
 *
 * The flags are computed once per row in `flags` and then counted with FILTER
 * clauses, so a 10,000-page crawl is scanned once instead of seven times. The
 * duplicate-content set is the one thing that needs its own pass -- "is this
 * hash shared" is a property of the crawl, not of the row.
 */
async function aggregateCrawl(crawlId: string): Promise<CoverageAgg> {
  const { rows } = await db.execute<CoverageAgg>(sql`
    WITH dupes AS (
      SELECT content_hash
      FROM pages
      WHERE crawl_id = ${crawlId}::uuid AND content_hash IS NOT NULL AND content_hash <> ''
      GROUP BY content_hash
      HAVING count(*) > 1
    ),
    flags AS (
      SELECT
        p.url,
        p.http_status,
        p.noindex IS TRUE AS f_noindex,
        p.http_status BETWEEN 300 AND 399 AS f_redirect,
        p.http_status = 403 AS f_403,
        p.http_status = 404 AS f_404,
        p.http_status >= 500 AS f_5xx,
        (p.http_status = 200
          AND p.canonical_url IS NOT NULL
          AND p.canonical_url <> ''
          AND p.canonical_url <> p.url) AS f_alt_canonical,
        -- content_hash is null-guarded before the IN so the expression is
        -- never NULL; a NULL here would drop the row out of every FILTER,
        -- including the indexable one.
        (p.http_status = 200
          AND (p.canonical_url IS NULL OR p.canonical_url = '')
          AND p.content_hash IS NOT NULL
          AND p.content_hash <> ''
          AND p.content_hash IN (SELECT content_hash FROM dupes)) AS f_dup_no_canonical
      FROM pages p
      WHERE p.crawl_id = ${crawlId}::uuid
    )
    SELECT
      count(*)::int AS total_crawled,
      count(*) FILTER (
        WHERE http_status = 200 AND NOT f_noindex AND NOT f_alt_canonical AND NOT f_dup_no_canonical
      )::int AS indexable,
      count(*) FILTER (WHERE f_noindex)::int AS n_noindex,
      (array_agg(url ORDER BY url) FILTER (WHERE f_noindex))[1:5] AS s_noindex,
      count(*) FILTER (WHERE f_redirect)::int AS n_redirect,
      (array_agg(url ORDER BY url) FILTER (WHERE f_redirect))[1:5] AS s_redirect,
      count(*) FILTER (WHERE f_403)::int AS n_403,
      (array_agg(url ORDER BY url) FILTER (WHERE f_403))[1:5] AS s_403,
      count(*) FILTER (WHERE f_404)::int AS n_404,
      (array_agg(url ORDER BY url) FILTER (WHERE f_404))[1:5] AS s_404,
      count(*) FILTER (WHERE f_5xx)::int AS n_5xx,
      (array_agg(url ORDER BY url) FILTER (WHERE f_5xx))[1:5] AS s_5xx,
      count(*) FILTER (WHERE f_alt_canonical)::int AS n_alt_canonical,
      (array_agg(url ORDER BY url) FILTER (WHERE f_alt_canonical))[1:5] AS s_alt_canonical,
      count(*) FILTER (WHERE f_dup_no_canonical)::int AS n_dup_no_canonical,
      (array_agg(url ORDER BY url) FILTER (WHERE f_dup_no_canonical))[1:5] AS s_dup_no_canonical
    FROM flags
  `);
  // An empty crawl still returns one row (aggregates with no GROUP BY), but
  // fall back rather than assume it.
  return rows[0] ?? EMPTY_AGG;
}

/**
 * The three reasons only Google can report, from stored URL Inspection rows.
 *
 * With no property linked or no inspections stored, every row comes back
 * `available: false` and `pages: 0` -- the UI shows "run a URL Inspection"
 * instead of implying Google found nothing wrong.
 */
async function googleSystemReasons(propertyId: string | null): Promise<CoverageReasonRow[]> {
  const reasons = [R_CRAWLED_NOT_INDEXED, R_DISCOVERED_NOT_INDEXED, R_GOOGLE_CANONICAL];
  const blank = (reason: string): CoverageReasonRow => ({
    reason,
    source: "Google systems",
    pages: 0,
    available: false,
    sampleUrls: [],
    detail: DETAILS[reason] as string,
  });

  if (propertyId === null) return reasons.map(blank);

  // A LEFT JOIN keeps all three reasons even when nothing matches; the FILTER
  // on array_agg is what stops an unmatched reason from aggregating the join's
  // single NULL row into a one-element `{NULL}` array.
  const { rows } = await db.execute<{ reason: string; n: number; urls: string[] | null }>(sql`
    SELECT r.reason,
           count(i.id)::int AS n,
           (array_agg(i.page_url ORDER BY i.page_url) FILTER (WHERE i.id IS NOT NULL))[1:5] AS urls
    FROM (VALUES
      (${R_CRAWLED_NOT_INDEXED}::text, ${GOOGLE_PATTERNS[R_CRAWLED_NOT_INDEXED]}::text),
      (${R_DISCOVERED_NOT_INDEXED}::text, ${GOOGLE_PATTERNS[R_DISCOVERED_NOT_INDEXED]}::text),
      (${R_GOOGLE_CANONICAL}::text, ${GOOGLE_PATTERNS[R_GOOGLE_CANONICAL]}::text)
    ) AS r(reason, pattern)
    LEFT JOIN gsc_url_inspections i
      ON i.property_id = ${propertyId}::uuid AND i.coverage_state ILIKE r.pattern
    GROUP BY r.reason
  `);

  const counts = new Map(rows.map((r) => [r.reason, r]));
  return reasons.map((reason) => {
    const hit = counts.get(reason);
    return {
      reason,
      source: "Google systems" as const,
      pages: Number(hit?.n ?? 0),
      // Provisional: the caller flips this off when the property holds no
      // inspections at all, since then a 0 means "never asked", not "none".
      available: true,
      sampleUrls: hit?.urls ?? [],
      detail: DETAILS[reason] as string,
    };
  });
}

/** Total stored inspections for the property -- what makes the Google rows answerable. */
async function countInspections(propertyId: string | null): Promise<number> {
  if (propertyId === null) return 0;
  const { rows } = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM gsc_url_inspections WHERE property_id = ${propertyId}::uuid
  `);
  return Number(rows[0]?.n ?? 0);
}
