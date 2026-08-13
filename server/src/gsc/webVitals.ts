import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { webVitals, websites } from "../db/schema.js";

/**
 * Core Web Vitals via PageSpeed Insights v5.
 *
 * No OAuth involved: PSI is a public API, keyed at most by an API key. Field
 * data (CrUX) is what Google actually ranks with, so it is preferred; a
 * Lighthouse lab run is the fallback when Google has no real-user data for
 * the URL. `source` records which one produced the stored numbers, because a
 * lab LCP and a field LCP are not comparable and the UI must say which it is.
 */

const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

/**
 * Gap between PSI calls. Unkeyed PSI allows roughly 1 request per 1.5s
 * before it starts returning 429s; keyed quota is far larger but sequential
 * pacing costs little on a batch of ten and never trips either limit.
 */
const REQUEST_GAP_MS = 1500;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export interface CwvRow {
  url: string;
  strategy: string;
  source: "field" | "lab" | "none";
  performanceScore: number | null;
  lcpMs: number | null;
  inpMs: number | null;
  cls: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
  categories: Record<string, string>;
  overall: string | null;
  collectedAt: string;
}

export interface WebVitalsRunResult {
  tested: number;
  failed: number;
  /** Set when the run stopped early (PSI quota) rather than finishing. */
  stoppedReason: string | null;
  rows: CwvRow[];
}

interface PsiMetric {
  percentile?: number;
  category?: string;
}

interface PsiResponse {
  loadingExperience?: {
    metrics?: Record<string, PsiMetric>;
    overall_category?: string;
  };
  lighthouseResult?: {
    categories?: { performance?: { score?: number } };
    audits?: Record<string, { numericValue?: number }>;
  };
}

/**
 * Runs PSI against this site's most valuable URLs and upserts the results.
 *
 * URL priority is impressions descending from Search Console -- the pages
 * users actually reach are the ones whose vitals matter. Without a linked
 * property (or with one that has no metrics yet) it falls back to the
 * homepage plus the most-linked crawled pages, which is the crawl's own
 * proxy for importance.
 */
export async function runWebVitals(
  websiteId: string,
  opts: { limit?: number; strategy?: "mobile" | "desktop" } = {},
): Promise<WebVitalsRunResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const strategy = opts.strategy ?? "mobile";
  const urls = await selectUrls(websiteId, limit);

  let tested = 0;
  let failed = 0;
  let stoppedReason: string | null = null;
  const rows: CwvRow[] = [];

  for (let i = 0; i < urls.length; i++) {
    // Pace between calls, not before the first -- see REQUEST_GAP_MS.
    if (i > 0) await sleep(REQUEST_GAP_MS);
    const url = urls[i] as string;

    try {
      const res = await fetch(psiUrl(url, strategy));

      if (res.status === 429) {
        // Unkeyed PSI quota is tiny (and keyed quota is still finite).
        // Every remaining URL would fail identically, so stop and say why
        // rather than burning the rest of the batch on guaranteed 429s.
        stoppedReason = process.env.PSI_API_KEY || process.env.GOOGLE_API_KEY
          ? "PageSpeed Insights rate limit hit. Wait a minute and run again."
          : "PageSpeed Insights rate limit hit. Without a PSI_API_KEY the shared quota is tiny -- add a key, or wait and run a smaller batch.";
        break;
      }

      if (!res.ok) {
        // PSI 400s/500s on individual URLs (unreachable page, Lighthouse
        // crash). That is a fact about the URL, not the batch -- record and
        // keep going.
        failed += 1;
        continue;
      }

      const json = (await res.json()) as PsiResponse;
      const collectedAt = new Date();
      const parsed = parsePsi(json);

      await db
        .insert(webVitals)
        .values({
          websiteId,
          url,
          strategy,
          source: parsed.source,
          performanceScore: parsed.performanceScore,
          lcpMs: parsed.lcpMs,
          inpMs: parsed.inpMs,
          cls: parsed.cls,
          fcpMs: parsed.fcpMs,
          ttfbMs: parsed.ttfbMs,
          categories: parsed.categories,
          overall: parsed.overall,
          collectedAt,
        })
        .onConflictDoUpdate({
          target: [webVitals.websiteId, webVitals.url, webVitals.strategy],
          set: {
            source: parsed.source,
            performanceScore: parsed.performanceScore,
            lcpMs: parsed.lcpMs,
            inpMs: parsed.inpMs,
            cls: parsed.cls,
            fcpMs: parsed.fcpMs,
            ttfbMs: parsed.ttfbMs,
            categories: parsed.categories,
            overall: parsed.overall,
            collectedAt,
          },
        });

      tested += 1;
      rows.push({ url, strategy, ...parsed, collectedAt: collectedAt.toISOString() });
    } catch (err) {
      failed += 1;
      console.error(`[cwv] PSI failed for ${url}:`, err instanceof Error ? err.message : err);
    }
  }

  return { tested, failed, stoppedReason, rows };
}

/** Stored vitals for one strategy, worst LCP first (nulls sort last). */
export async function getWebVitalsRows(websiteId: string, strategy: string): Promise<CwvRow[]> {
  const stored = await db
    .select()
    .from(webVitals)
    .where(and(eq(webVitals.websiteId, websiteId), eq(webVitals.strategy, strategy)))
    .orderBy(sql`${webVitals.lcpMs} DESC NULLS LAST`, webVitals.url);

  return stored.map((r) => ({
    url: r.url,
    strategy: r.strategy,
    source: r.source as CwvRow["source"],
    performanceScore: r.performanceScore,
    lcpMs: r.lcpMs,
    inpMs: r.inpMs,
    cls: r.cls,
    fcpMs: r.fcpMs,
    ttfbMs: r.ttfbMs,
    categories: r.categories ?? {},
    overall: r.overall,
    collectedAt: r.collectedAt.toISOString(),
  }));
}

function psiUrl(url: string, strategy: string): string {
  const params = new URLSearchParams({ url, strategy, category: "performance" });
  // Optional but strongly recommended: without a key PSI shares a tiny
  // global quota and 429s within a handful of calls.
  const key = process.env.PSI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (key) params.set("key", key);
  return `${PSI_ENDPOINT}?${params}`;
}

type ParsedPsi = Omit<CwvRow, "url" | "strategy" | "collectedAt">;

function parsePsi(json: PsiResponse): ParsedPsi {
  const metrics = json.loadingExperience?.metrics ?? {};
  const lcp = metrics["LARGEST_CONTENTFUL_PAINT_MS"];
  const inp = metrics["INTERACTION_TO_NEXT_PAINT"];
  const clsScore = metrics["CUMULATIVE_LAYOUT_SHIFT_SCORE"];
  const fcp = metrics["FIRST_CONTENTFUL_PAINT_MS"];
  const ttfb = metrics["EXPERIMENTAL_TIME_TO_FIRST_BYTE"];

  // Lighthouse runs regardless of field-data availability, so the score is
  // recorded whenever present -- it is a lab figure either way.
  const lh = json.lighthouseResult;
  const score = lh?.categories?.performance?.score;
  const performanceScore = typeof score === "number" ? Math.round(score * 100) : null;

  const hasField = [lcp, inp, clsScore, fcp, ttfb].some((m) => m?.percentile !== undefined);
  if (hasField) {
    const categories: Record<string, string> = {};
    if (lcp?.category) categories["LCP"] = lcp.category;
    if (inp?.category) categories["INP"] = inp.category;
    if (clsScore?.category) categories["CLS"] = clsScore.category;
    if (fcp?.category) categories["FCP"] = fcp.category;
    if (ttfb?.category) categories["TTFB"] = ttfb.category;

    return {
      source: "field",
      performanceScore,
      lcpMs: intOrNull(lcp?.percentile),
      inpMs: intOrNull(inp?.percentile),
      // CrUX reports CLS scaled by 100 (e.g. 8 means 0.08).
      cls: clsScore?.percentile !== undefined ? clsScore.percentile / 100 : null,
      fcpMs: intOrNull(fcp?.percentile),
      ttfbMs: intOrNull(ttfb?.percentile),
      categories,
      overall: json.loadingExperience?.overall_category ?? null,
    };
  }

  if (lh?.audits) {
    const audits = lh.audits;
    return {
      source: "lab",
      performanceScore,
      lcpMs: intOrNull(audits["largest-contentful-paint"]?.numericValue),
      // INP needs real user input; a lab run has none, so it is always null.
      inpMs: null,
      cls: audits["cumulative-layout-shift"]?.numericValue ?? null,
      fcpMs: intOrNull(audits["first-contentful-paint"]?.numericValue),
      ttfbMs: intOrNull(audits["server-response-time"]?.numericValue),
      categories: {},
      overall: null,
    };
  }

  return {
    source: "none",
    performanceScore,
    lcpMs: null,
    inpMs: null,
    cls: null,
    fcpMs: null,
    ttfbMs: null,
    categories: {},
    overall: null,
  };
}

const intOrNull = (v: number | undefined): number | null =>
  v === undefined ? null : Math.round(v);

/**
 * Picks the URLs worth testing, in priority order.
 *
 * First choice: pages by summed Search Console impressions -- real traffic
 * is the best importance signal available. Fallback (no linked property, or
 * a property with no metrics yet): homepage plus the most internally-linked
 * pages from the latest completed crawl.
 */
async function selectUrls(websiteId: string, limit: number): Promise<string[]> {
  const { rows: byImpressions } = await db.execute<{ page_url: string }>(sql`
    SELECT m.page_url
    FROM gsc_page_metrics m
    JOIN gsc_properties gp ON gp.id = m.property_id
    WHERE gp.website_id = ${websiteId}
    GROUP BY m.page_url
    ORDER BY sum(m.impressions) DESC, m.page_url
    LIMIT ${limit}
  `);
  if (byImpressions.length > 0) return byImpressions.map((r) => r.page_url);

  const [site] = await db
    .select({ originalUrl: websites.originalUrl })
    .from(websites)
    .where(eq(websites.id, websiteId));
  if (!site) throw new Error("Website not found.");

  const urls = new Set<string>([site.originalUrl]);

  const { rows: crawled } = await db.execute<{ url: string }>(sql`
    SELECT coalesce(p.final_url, p.url) AS url
    FROM pages p
    WHERE p.crawl_id = (
      SELECT c.id FROM crawls c
      WHERE c.website_id = ${websiteId} AND c.status = 'COMPLETED'
      ORDER BY c.started_at DESC NULLS LAST, c.id
      LIMIT 1
    )
      AND p.http_status = 200
    ORDER BY p.inbound_link_count DESC NULLS LAST, p.id
    LIMIT ${limit}
  `);
  for (const r of crawled) {
    if (urls.size >= limit) break;
    urls.add(r.url);
  }

  return [...urls].slice(0, limit);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
