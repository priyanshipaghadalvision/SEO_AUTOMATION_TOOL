import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

/**
 * Crawl-derived site insights: links, structured data, viewport coverage.
 *
 * Nothing here comes from Search Console -- Google exposes no API for links,
 * enhancements or (since December 2023) mobile usability, so every number
 * below is read out of our own latest completed crawl. The UI says so in each
 * tab's caption; this module's job is only to be honest about the source and
 * never to imply Google supplied it.
 *
 * All reads. Zero writes.
 */

export interface LinkPageRow {
  url: string;
  title: string | null;
  inboundLinks: number;
  depth: number | null;
}

export interface LinkDomainRow {
  domain: string;
  links: number;
  sourcePages: number;
}

export interface OrphanRow {
  url: string;
  title: string | null;
  depth: number | null;
}

export interface EnhancementTypeRow {
  type: string;
  pages: number;
  items: number;
  /** At most 3, deduplicated -- see the array_agg in getEnhancements. */
  sampleUrls: string[];
}

export type LinkView = "pages" | "domains" | "orphans";

export interface LinkInsightsResult {
  view: LinkView;
  total: number;
  offset: number;
  limit: number;
  rows: LinkPageRow[] | LinkDomainRow[] | OrphanRow[];
}

export interface EnhancementsResult {
  totalPages: number;
  pagesWithData: number;
  pagesWithNone: number;
  types: EnhancementTypeRow[];
}

export interface MobileUsabilityResult {
  totalPages: number;
  withViewport: number;
  missingViewport: number;
  /** Capped -- see MAX_MISSING_ROWS. */
  missingViewportRows: Array<{ url: string; title: string | null }>;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * The missing-viewport list is evidence, not an export: past a hundred rows
 * the answer is "this site has no viewport tag", which the counts already say.
 */
const MAX_MISSING_ROWS = 100;

/**
 * Display URL. A crawled row keys on the URL we requested, so a redirected
 * page is only recognisable by where it landed -- matching mergedUrls.
 */
const PAGE_URL = sql`coalesce(p.final_url, p.url)`;

/** Host of an outbound link, or NULL for anything that isn't an http(s) URL. */
const DOMAIN_KEY = sql`substring(l->>'url' FROM '^https?://([^/]+)')`;

/**
 * The JSON-LD type of one structured-data item.
 *
 * `@type` (never `type` -- these are raw parsed JSON-LD blobs) is a string on
 * most items and an array on some. The array branch has to be tried FIRST:
 * `->>` on an array does not return NULL, it stringifies the whole thing, so
 * the string-first order would group an `["Organization","LocalBusiness"]`
 * page under the literal text `["Organization","LocalBusiness"]`. Indexing a
 * JSON string with `->0` does return NULL, so this order resolves both.
 * Items with no resolvable `@type` (bare `@graph` wrappers) are dropped.
 */
const TYPE_KEY = sql`coalesce(item->'@type'->>0, item->>'@type')`;

/**
 * Link-graph views over the latest completed crawl, server-paged.
 *
 * `total` counts the whole view, not the page, because the pager needs it --
 * for domains that means counting the grouped set, not the link rows.
 */
export async function getLinkInsights(
  websiteId: string,
  opts: { view?: LinkView; limit?: number; offset?: number } = {},
): Promise<LinkInsightsResult> {
  const view: LinkView = opts.view ?? "pages";
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const offset = Math.max(0, opts.offset ?? 0);

  const crawlId = await latestCompletedCrawlId(websiteId);
  // No crawl yet is an empty state, not an error -- the route returns 200 and
  // the UI says "Run a crawl".
  if (!crawlId) return { view, total: 0, offset, limit, rows: [] };

  if (view === "domains") {
    // One row per outbound host. `count(*)` counts link occurrences (a page
    // linking the same domain twice counts twice) while `source_pages` counts
    // the distinct pages doing the linking -- both matter, and neither can be
    // derived from the other.
    const [{ rows }, { rows: countRows }] = await Promise.all([
      db.execute<{ domain: string; links: number; source_pages: number }>(sql`
        SELECT ${DOMAIN_KEY} AS domain,
               count(*)::int AS links,
               count(DISTINCT p.id)::int AS source_pages
        FROM pages p, jsonb_array_elements(coalesce(p.external_links, '[]'::jsonb)) l
        WHERE p.crawl_id = ${crawlId}::uuid
        GROUP BY 1
        HAVING ${DOMAIN_KEY} IS NOT NULL
        ORDER BY links DESC, domain
        LIMIT ${limit} OFFSET ${offset}
      `),
      db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM (
          SELECT ${DOMAIN_KEY} AS domain
          FROM pages p, jsonb_array_elements(coalesce(p.external_links, '[]'::jsonb)) l
          WHERE p.crawl_id = ${crawlId}::uuid
          GROUP BY 1
          HAVING ${DOMAIN_KEY} IS NOT NULL
        ) d
      `),
    ]);

    return {
      view,
      total: Number(countRows[0]?.n ?? 0),
      offset,
      limit,
      rows: rows.map((r) => ({
        domain: r.domain,
        links: Number(r.links),
        sourcePages: Number(r.source_pages),
      })),
    };
  }

  if (view === "orphans") {
    // Depth > 0 excludes the entry point: the homepage is reached directly,
    // not by an internal link, so a zero inbound count there is expected
    // rather than a finding.
    const where = sql`
      p.crawl_id = ${crawlId}::uuid
        AND p.inbound_link_count = 0
        AND p.depth > 0
        AND p.http_status = 200`;

    const [{ rows }, { rows: countRows }] = await Promise.all([
      db.execute<{ url: string; title: string | null; depth: number | null }>(sql`
        SELECT ${PAGE_URL} AS url, p.title, p.depth
        FROM pages p
        WHERE ${where}
        ORDER BY ${PAGE_URL}, p.id
        LIMIT ${limit} OFFSET ${offset}
      `),
      db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pages p WHERE ${where}
      `),
    ]);

    return {
      view,
      total: Number(countRows[0]?.n ?? 0),
      offset,
      limit,
      rows: rows.map((r) => ({
        url: r.url,
        title: r.title,
        depth: r.depth === null ? null : Number(r.depth),
      })),
    };
  }

  // "pages": most internally-linked first. Redirects and errors are excluded
  // (200 only) because link equity pointed at a 404 is a different finding.
  const where = sql`p.crawl_id = ${crawlId}::uuid AND p.http_status = 200`;

  const [{ rows }, { rows: countRows }] = await Promise.all([
    db.execute<{ url: string; title: string | null; inbound_links: number; depth: number | null }>(sql`
      SELECT ${PAGE_URL} AS url, p.title,
             coalesce(p.inbound_link_count, 0)::int AS inbound_links,
             p.depth
      FROM pages p
      WHERE ${where}
      ORDER BY p.inbound_link_count DESC NULLS LAST, p.id
      LIMIT ${limit} OFFSET ${offset}
    `),
    db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pages p WHERE ${where}
    `),
  ]);

  return {
    view: "pages",
    total: Number(countRows[0]?.n ?? 0),
    offset,
    limit,
    rows: rows.map((r) => ({
      url: r.url,
      title: r.title,
      inboundLinks: Number(r.inbound_links),
      depth: r.depth === null ? null : Number(r.depth),
    })),
  };
}

/**
 * Structured-data coverage for the latest completed crawl, by schema.org type.
 *
 * Both halves are scoped to status-200 pages so the type table and the
 * coverage cards describe the same set of pages -- a type found only on a 404
 * would otherwise appear in a table whose totals never counted it.
 */
export async function getEnhancements(websiteId: string): Promise<EnhancementsResult> {
  const crawlId = await latestCompletedCrawlId(websiteId);
  if (!crawlId) return { totalPages: 0, pagesWithData: 0, pagesWithNone: 0, types: [] };

  const [{ rows: coverage }, { rows: types }] = await Promise.all([
    db.execute<{ total_pages: number; with_data: number }>(sql`
      SELECT count(*)::int AS total_pages,
             (count(*) FILTER (
               WHERE jsonb_typeof(p.structured_data) = 'array'
                 AND jsonb_array_length(p.structured_data) > 0
             ))::int AS with_data
      FROM pages p
      WHERE p.crawl_id = ${crawlId}::uuid AND p.http_status = 200
    `),
    db.execute<{ type: string; pages: number; items: number; sample_urls: string[] | null }>(sql`
      SELECT ${TYPE_KEY} AS type,
             count(DISTINCT p.id)::int AS pages,
             count(*)::int AS items,
             -- DISTINCT so a page carrying three Product blocks doesn't fill
             -- all three sample slots with its own URL; it also fixes the
             -- sample order, which array_agg alone would leave to the planner.
             (array_agg(DISTINCT ${PAGE_URL}))[1:3] AS sample_urls
      FROM pages p, jsonb_array_elements(coalesce(p.structured_data, '[]'::jsonb)) item
      WHERE p.crawl_id = ${crawlId}::uuid AND p.http_status = 200
      GROUP BY 1
      HAVING ${TYPE_KEY} IS NOT NULL
      ORDER BY pages DESC, type
    `),
  ]);

  const totalPages = Number(coverage[0]?.total_pages ?? 0);
  const pagesWithData = Number(coverage[0]?.with_data ?? 0);

  return {
    totalPages,
    pagesWithData,
    pagesWithNone: totalPages - pagesWithData,
    types: types.map((r) => ({
      type: r.type,
      pages: Number(r.pages),
      items: Number(r.items),
      sampleUrls: r.sample_urls ?? [],
    })),
  };
}

/**
 * Viewport coverage for the latest completed crawl.
 *
 * Google retired the Mobile Usability API in December 2023, so a missing
 * `<meta name="viewport">` is the one mobile defect still detectable from a
 * crawl -- and it is the one that breaks a page on a phone outright. An empty
 * viewport attribute counts as missing: it renders exactly like no tag at all.
 */
export async function getMobileUsability(websiteId: string): Promise<MobileUsabilityResult> {
  const crawlId = await latestCompletedCrawlId(websiteId);
  if (!crawlId) {
    return { totalPages: 0, withViewport: 0, missingViewport: 0, missingViewportRows: [] };
  }

  const [{ rows: counts }, { rows: missing }] = await Promise.all([
    db.execute<{ total_pages: number; with_viewport: number }>(sql`
      SELECT count(*)::int AS total_pages,
             (count(*) FILTER (
               WHERE p.viewport IS NOT NULL AND p.viewport <> ''
             ))::int AS with_viewport
      FROM pages p
      WHERE p.crawl_id = ${crawlId}::uuid AND p.http_status = 200
    `),
    db.execute<{ url: string; title: string | null }>(sql`
      SELECT ${PAGE_URL} AS url, p.title
      FROM pages p
      WHERE p.crawl_id = ${crawlId}::uuid
        AND p.http_status = 200
        AND (p.viewport IS NULL OR p.viewport = '')
      ORDER BY ${PAGE_URL}, p.id
      LIMIT ${MAX_MISSING_ROWS}
    `),
  ]);

  const totalPages = Number(counts[0]?.total_pages ?? 0);
  const withViewport = Number(counts[0]?.with_viewport ?? 0);

  return {
    totalPages,
    withViewport,
    // Derived, not counted again: the two queries would otherwise be able to
    // disagree if a crawl finished writing between them.
    missingViewport: totalPages - withViewport,
    missingViewportRows: missing.map((r) => ({ url: r.url, title: r.title })),
  };
}

/**
 * The crawl every read here is scoped to.
 *
 * `status = 'COMPLETED'` -- crawl_status is an UPPERCASE enum, and a lowercase
 * literal matches nothing rather than failing loudly. `started_at` is nullable
 * (a crawl that never left the queue), so NULLS LAST keeps those behind real
 * crawls, and the id tiebreak keeps the choice stable across calls.
 *
 * Returns null when the site has never completed a crawl; every caller turns
 * that into zeros and empty rows rather than an error.
 */
async function latestCompletedCrawlId(websiteId: string): Promise<string | null> {
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT c.id
    FROM crawls c
    WHERE c.website_id = ${websiteId} AND c.status = 'COMPLETED'
    ORDER BY c.started_at DESC NULLS LAST, c.id
    LIMIT 1
  `);
  return rows[0]?.id ?? null;
}
