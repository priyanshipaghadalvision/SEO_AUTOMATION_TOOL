import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import type { DateRange } from "./dateRange.js";

/**
 * The unified URL view: one row per URL, whatever we know about it.
 *
 * Three sources feed this -- our crawl (`pages`), Search Console traffic
 * (`gsc_page_metrics`) and Google's index verdict (`gsc_url_inspections`) --
 * joined on the shared normalized key. A FULL OUTER JOIN rather than an inner
 * one is the whole point: the URLs that appear on only one side are the
 * interesting ones. A page Google sends traffic to but our crawler never
 * reached is a discovery gap; a page we crawled that Google has never shown
 * is either not indexed or not worth indexing.
 *
 * Matching is case-insensitive. Measured on a real property, exact matching
 * found 27 of 100 crawled pages and case-insensitive found 34, because Google
 * had indexed "/category/Agility" while the site linked "/category/agility".
 * Checked first that Search Console holds no case-variant duplicates of its
 * own, so folding case cannot merge two genuinely different pages here.
 */

export type Bucket =
  | "not_indexed"
  | "not_crawled"
  | "indexed_traffic"
  | "indexed_no_clicks"
  | "crawled_no_data";

export interface MergedUrlRow {
  url: string;
  bucket: Bucket;
  /** Crawl side. */
  httpStatus: number | null;
  title: string | null;
  wordCount: number | null;
  inboundLinkCount: number | null;
  noindex: boolean | null;
  issueCount: number;
  /** Search Console side. */
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
  /** Index verdict. */
  verdict: string | null;
  coverageState: string | null;
}

export interface MergedUrlsResult {
  rows: MergedUrlRow[];
  counts: Record<Bucket, number>;
  /** Every URL in the view, ignoring the active filter. */
  total: number;
  /** URLs matching the active bucket/search filter -- what the pager counts. */
  matched: number;
  offset: number;
  limit: number;
  /** Which crawl the crawl-side columns came from. */
  crawlId: string | null;
}

/**
 * Rows per request. This is a page size, not a ceiling on the data: the pager
 * walks the whole set. It used to be a hard 2,000-row cap that silently hid
 * the other 8,500 URLs of a 10,508-URL site behind a "capped" note.
 */
const MAX_ROWS = 500;

/**
 * Buckets are assigned in priority order, not by scoring, so every URL lands
 * in exactly one. Order matters: a page that is both untracked by us *and*
 * flagged not-indexed by Google is a not-indexed problem first.
 */
const BUCKET_SQL = sql`
  CASE
    WHEN verdict IN ('FAIL', 'NEUTRAL') THEN 'not_indexed'
    WHEN NOT crawled THEN 'not_crawled'
    WHEN clicks > 0 THEN 'indexed_traffic'
    WHEN impressions > 0 THEN 'indexed_no_clicks'
    ELSE 'crawled_no_data'
  END`;

export async function getMergedUrls(
  websiteId: string,
  propertyId: string | null,
  range: DateRange,
  opts: { bucket?: Bucket; search?: string; limit?: number; offset?: number } = {},
): Promise<MergedUrlsResult> {
  // Pin the crawl side to one crawl. Page rows exist per crawl, so joining
  // across all of them would count a URL once per crawl it appeared in.
  // Newest crawl that actually produced pages -- not newest COMPLETED, since
  // a large crawl still running already holds more data than the last
  // finished one.
  const { rows: crawlRows } = await db.execute<{ id: string }>(sql`
    SELECT c.id FROM crawls c
    WHERE c.website_id = ${websiteId}
      AND EXISTS (SELECT 1 FROM pages p WHERE p.crawl_id = c.id)
    ORDER BY c.created_at DESC
    LIMIT 1
  `);
  const crawlId = crawlRows[0]?.id ?? null;

  const limit = Math.min(MAX_ROWS, Math.max(1, opts.limit ?? 100));
  const offset = Math.max(0, opts.offset ?? 0);

  const conditions = [
    ...(opts.bucket ? [sql`bucket = ${opts.bucket}`] : []),
    ...(opts.search ? [sql`url ILIKE ${"%" + opts.search + "%"}`] : []),
  ];
  const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

  /**
   * The CTE chain, shared by the row query and the count query.
   *
   * Kept as one fragment ending in `merged AS (...)` so both callers can say
   * `WITH ${cte} SELECT ... FROM merged`. Nesting these inside a single
   * `merged AS (...)` is invalid SQL -- CTEs have to sit at the top of the
   * WITH clause, not inside another CTE's body.
   */
  const cte = sql`
    issue_counts AS (
      SELECT page_id, count(*)::int AS n
      FROM issues
      WHERE crawl_id = ${crawlId}::uuid AND page_id IS NOT NULL
      GROUP BY page_id
    ),
    crawl AS (
      SELECT p.id, lower(p.normalized_url) AS k, COALESCE(p.final_url, p.url) AS url,
             p.http_status, p.title, p.word_count, p.inbound_link_count, p.noindex,
             COALESCE(ic.n, 0) AS issue_count
      FROM pages p
      LEFT JOIN issue_counts ic ON ic.page_id = p.id
      WHERE p.crawl_id = ${crawlId}::uuid
    ),
    gsc AS (
      SELECT lower(m.normalized_url) AS k,
             max(m.page_url) AS url,
             sum(m.clicks)::int AS clicks,
             sum(m.impressions)::int AS impressions,
             CASE WHEN sum(m.impressions) = 0 THEN 0
                  ELSE sum(m.clicks)::float / sum(m.impressions) END AS ctr,
             CASE WHEN sum(m.impressions) = 0 THEN NULL
                  ELSE sum(m.position * m.impressions) / sum(m.impressions) END AS position
      FROM gsc_page_metrics m
      WHERE m.property_id = ${propertyId}::uuid
        AND m.normalized_url IS NOT NULL
        AND m.date BETWEEN ${range.startDate}::date AND ${range.endDate}::date
      GROUP BY 1
    ),
    insp AS (
      SELECT DISTINCT ON (lower(normalized_url)) lower(normalized_url) AS k, verdict, coverage_state
      FROM gsc_url_inspections
      WHERE property_id = ${propertyId}::uuid AND normalized_url IS NOT NULL
      ORDER BY lower(normalized_url), inspected_at DESC
    ),
    merged AS (
      SELECT COALESCE(p.url, g.url) AS url,
             p.id IS NOT NULL AS crawled,
             p.http_status, p.title, p.word_count, p.inbound_link_count, p.noindex,
             COALESCE(p.issue_count, 0) AS issue_count,
             COALESCE(g.clicks, 0) AS clicks,
             COALESCE(g.impressions, 0) AS impressions,
             g.position,
             i.verdict, i.coverage_state
      FROM crawl p
      FULL OUTER JOIN gsc g ON g.k = p.k
      LEFT JOIN insp i ON i.k = COALESCE(p.k, g.k)
    ),
    /*
     * One row per URL -- the promise this view makes, which the join alone
     * does not keep.
     *
     * Rows are keyed on the URL we requested but displayed as the URL we
     * landed on, so redirects collapse several keys onto one address: three
     * crawled category paths all redirect to /android-games/, and Google
     * reports two key variants of it. That produced four rows reading
     * "/android-games/", each holding a fragment of the truth -- one had the
     * 103 impressions, another had the crawl, the rest showed zeroes.
     *
     * Aggregating rather than picking a winner is why this is a GROUP BY and
     * not a DISTINCT ON. Picking the highest-impression row looked right and
     * was worse: it kept the Google-only row and so labelled a page we had
     * crawled "not crawled". Traffic sums (every key's clicks landed on this
     * one page), crawl facts come from whichever row was crawled, and the
     * bucket is recomputed afterwards from the combined result -- so it can
     * no longer contradict the row it labels.
     *
     * The redirect sources are not lost; the crawled-pages view still lists
     * each one with its own target.
     */
    deduped AS (
      SELECT url,
             bool_or(crawled) AS crawled,
             -- Crawl columns are NULL on Google-only rows, and max() skips
             -- NULLs, so these take the crawled row's value when one exists.
             max(http_status) AS http_status,
             (array_agg(title ORDER BY (title IS NULL), inbound_link_count DESC NULLS LAST))[1] AS title,
             max(word_count) AS word_count,
             max(inbound_link_count) AS inbound_link_count,
             bool_or(noindex) AS noindex,
             -- max, not sum: a redirect source's own issues belong to the
             -- source, and summing would inflate the destination's count.
             max(issue_count) AS issue_count,
             sum(clicks)::int AS clicks,
             sum(impressions)::int AS impressions,
             CASE WHEN sum(impressions) = 0 THEN 0
                  ELSE sum(clicks)::float / sum(impressions) END AS ctr,
             CASE WHEN sum(impressions) = 0 THEN NULL
                  ELSE sum(position * impressions) / sum(impressions) END AS position,
             -- Verdict and its explanation must come from the same row, so
             -- both use one ordering: a real verdict first, then whichever
             -- key Google sends the most traffic to.
             (array_agg(verdict ORDER BY (verdict IS NULL), impressions DESC))[1] AS verdict,
             (array_agg(coverage_state ORDER BY (verdict IS NULL), impressions DESC))[1] AS coverage_state
      FROM merged
      GROUP BY url
    ),
    bucketed AS (
      SELECT *, ${BUCKET_SQL} AS bucket FROM deduped
    )`;

  const [{ rows }, { rows: countRows }, { rows: matchedRows }] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      WITH ${cte}
      SELECT * FROM bucketed ${where}
      ORDER BY impressions DESC, issue_count DESC, url
      LIMIT ${limit} OFFSET ${offset}
    `),
    // Counts always cover every bucket, ignoring the active filter -- the
    // cards are how you switch filters, so they must not collapse to the one
    // you already chose. Read from `deduped` too, or the cards would total
    // more URLs than the table can ever show.
    db.execute<{ bucket: Bucket; n: number }>(sql`
      WITH ${cte}
      SELECT bucket, count(*)::int AS n FROM bucketed GROUP BY bucket
    `),
    // The pager needs the filtered count, which the bucket cards cannot give:
    // a search term narrows the set within whichever bucket is selected.
    db.execute<{ n: number }>(sql`
      WITH ${cte}
      SELECT count(*)::int AS n FROM bucketed ${where}
    `),
  ]);

  const counts: Record<Bucket, number> = {
    not_indexed: 0,
    not_crawled: 0,
    indexed_traffic: 0,
    indexed_no_clicks: 0,
    crawled_no_data: 0,
  };
  for (const r of countRows) counts[r.bucket] = r.n;

  return {
    rows: rows.map((r) => ({
      url: String(r.url),
      bucket: r.bucket as Bucket,
      httpStatus: r.http_status as number | null,
      title: r.title as string | null,
      wordCount: r.word_count as number | null,
      inboundLinkCount: r.inbound_link_count as number | null,
      noindex: r.noindex as boolean | null,
      issueCount: Number(r.issue_count ?? 0),
      clicks: Number(r.clicks ?? 0),
      impressions: Number(r.impressions ?? 0),
      ctr: Number(r.ctr ?? 0),
      position: r.position === null ? null : Number(r.position),
      verdict: r.verdict as string | null,
      coverageState: r.coverage_state as string | null,
    })),
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    matched: matchedRows[0]?.n ?? 0,
    offset,
    limit,
    crawlId,
  };
}
