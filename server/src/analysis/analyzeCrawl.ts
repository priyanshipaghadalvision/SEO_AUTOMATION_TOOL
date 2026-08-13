import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { crawls, issues, pages } from "../db/schema.js";
import type { Finding, PageFacts } from "./rules.js";
import { WEAK_INBOUND_LINKS, analyzePage, analyzeSite } from "./rules.js";
import { normalizePageUrl } from "../lib/url.js";

export interface AnalysisResult extends Record<string, unknown> {
  issuesFound: number;
  bySeverity: { critical: number; warning: number; notice: number };
}

/**
 * Turns a finished crawl's raw page data into a list of SEO issues.
 *
 * Runs as a separate pass after the crawl rather than inline with it, for
 * two reasons: the cross-page rules (duplicate titles, orphan pages, broken
 * internal links) simply cannot be evaluated until every page has been
 * seen, and keeping analysis out of the request handler means a rule bug
 * can never corrupt or slow the crawl itself.
 *
 * Idempotent: existing issues for the crawl are deleted first, so
 * re-analysing a crawl replaces its findings rather than duplicating them.
 */
export async function analyzeCrawl(crawlId: string): Promise<AnalysisResult> {
  const [crawl] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
  if (!crawl) throw new Error(`Crawl ${crawlId} not found`);

  const rows = await loadPagesForAnalysis(crawlId);

  // Inbound link counts must be computed before the per-page rules run,
  // since orphan/weak-link detection depends on them.
  const inbound = countInboundLinks(rows);
  await persistInboundCounts(rows, inbound);

  const findings: Array<Finding & { pageId: string | null; url: string | null }> = [];

  for (const f of analyzeSite(crawl.siteAudit)) {
    findings.push({ ...f, pageId: null, url: null });
  }

  const indexableRows = rows.filter((p) => (p.httpStatus ?? 0) < 300 && !p.noindex);

  for (const row of rows) {
    const facts: PageFacts = {
      id: row.id,
      url: row.url,
      finalUrl: row.finalUrl,
      httpStatus: row.httpStatus,
      redirectChain: row.redirectChain,
      errorMessage: row.errorMessage,
      depth: row.depth,
      title: row.title,
      metaDescription: row.metaDescription,
      canonicalUrl: row.canonicalUrl,
      noindex: row.noindex ?? false,
      nofollow: row.nofollow ?? false,
      headings: row.headings ?? [],
      images: row.images ?? [],
      structuredData: row.structuredData ?? [],
      wordCount: row.wordCount ?? 0,
      internalLinkCount: row.internalLinkCount ?? 0,
      externalLinkCount: row.externalLinkCount ?? 0,
      inboundLinkCount: inbound.get(row.normalizedUrl) ?? 0,
      blockingScriptCount: row.blockingScriptCount ?? 0,
      htmlBytes: row.htmlBytes,
      responseTimeMs: row.responseTimeMs,
    };

    for (const f of analyzePage(facts)) {
      findings.push({ ...f, pageId: row.id, url: row.url });
    }
  }

  findings.push(...crossPageFindings(rows, indexableRows, inbound));

  await db.delete(issues).where(eq(issues.crawlId, crawlId));

  if (findings.length > 0) {
    // Chunked: a large crawl can produce tens of thousands of findings, and
    // Postgres caps a statement at 65535 bind parameters.
    const CHUNK = 500;
    for (let i = 0; i < findings.length; i += CHUNK) {
      await db.insert(issues).values(
        findings.slice(i, i + CHUNK).map((f) => ({
          crawlId,
          pageId: f.pageId,
          type: f.type,
          severity: f.severity,
          risk: f.risk,
          autoFixable: f.autoFixable,
          message: f.message,
          url: f.url,
          detail: f.detail ?? null,
        })),
      );
    }
  }

  const bySeverity = { critical: 0, warning: 0, notice: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;

  return { issuesFound: findings.length, bySeverity };
}

/**
 * Broken links are stored in full up to this many per page. Unlike images,
 * there is no cheap way to re-derive which targets were broken from the page
 * record alone -- that needs the whole crawl's status map -- so the evidence
 * has to be self-contained.
 */
const MAX_STORED_BROKEN_TARGETS = 50;

/**
 * Every column the analysis actually reads.
 *
 * Deliberately not `select()`: the full row carries `contentText` (up to 40KB
 * a page) and `openGraph`/`hreflang`/`scripts`, none of which any rule looks
 * at. On a 1,000-page crawl that was ~16MB of text shipped to Node, parsed,
 * and held in memory purely to be ignored.
 */
const ANALYSIS_COLUMNS = {
  id: pages.id,
  url: pages.url,
  finalUrl: pages.finalUrl,
  normalizedUrl: pages.normalizedUrl,
  httpStatus: pages.httpStatus,
  redirectChain: pages.redirectChain,
  depth: pages.depth,
  errorMessage: pages.errorMessage,
  title: pages.title,
  metaDescription: pages.metaDescription,
  canonicalUrl: pages.canonicalUrl,
  noindex: pages.noindex,
  nofollow: pages.nofollow,
  headings: pages.headings,
  images: pages.images,
  structuredData: pages.structuredData,
  wordCount: pages.wordCount,
  internalLinks: pages.internalLinks,
  internalLinkCount: pages.internalLinkCount,
  externalLinkCount: pages.externalLinkCount,
  blockingScriptCount: pages.blockingScriptCount,
  htmlBytes: pages.htmlBytes,
  responseTimeMs: pages.responseTimeMs,
  contentHash: pages.contentHash,
} as const;

type PageRow = {
  [K in keyof typeof ANALYSIS_COLUMNS]: (typeof pages.$inferSelect)[K];
};

/**
 * Reads the crawl's pages in pages-sized chunks rather than one statement.
 *
 * `internalLinks` alone is ~38MB of jsonb per 1,000 pages, and a single
 * `SELECT` holds one connection open for the whole transfer while Postgres
 * decompresses every TOASTed value at once. Chunking returns the connection
 * between batches, so an interactive request arriving mid-analysis waits
 * milliseconds instead of seconds -- which is the whole point of this
 * change, since analysis runs immediately after every crawl.
 */
async function loadPagesForAnalysis(crawlId: string): Promise<PageRow[]> {
  const CHUNK = 250;
  const out: PageRow[] = [];

  for (let offset = 0; ; offset += CHUNK) {
    const batch = await db
      .select(ANALYSIS_COLUMNS)
      .from(pages)
      .where(eq(pages.crawlId, crawlId))
      .orderBy(pages.id)
      .limit(CHUNK)
      .offset(offset);

    out.push(...batch);
    if (batch.length < CHUNK) return out;
  }
}

/** One broken link, with everything needed to locate and fix it. */
interface BrokenLinkHit {
  url: string;
  status: number;
  anchor: string | null;
  selector: string | null;
  snippet: string | null;
  occurrences: number;
}

/**
 * Builds inbound-link counts by walking every page's stored internal links
 * and normalising each target the same way the crawler normalised page URLs
 * -- without that, "/about" and "/about/" would be counted as two different
 * destinations and almost every page would look orphaned.
 */
function countInboundLinks(rows: PageRow[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const source = row.finalUrl ?? row.url;
    for (const link of row.internalLinks ?? []) {
      const normalized = normalizePageUrl(link.url, source);
      if (!normalized) continue;
      // Self-links tell us nothing about how reachable a page is.
      if (normalized.normalizedUrl === row.normalizedUrl) continue;
      counts.set(normalized.normalizedUrl, (counts.get(normalized.normalizedUrl) ?? 0) + 1);
    }
  }

  return counts;
}

async function persistInboundCounts(rows: PageRow[], inbound: Map<string, number>): Promise<void> {
  // One statement per page would mean thousands of round trips on a large
  // crawl; a single UPDATE ... FROM (VALUES ...) keeps it to a handful.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values = sql.join(
      slice.map((r) => sql`(${r.id}::uuid, ${inbound.get(r.normalizedUrl) ?? 0}::int)`),
      sql`, `,
    );
    await db.execute(
      sql`UPDATE pages SET inbound_link_count = v.count
          FROM (VALUES ${values}) AS v(id, count)
          WHERE pages.id = v.id`,
    );
  }
}

/**
 * Rules that need the whole crawl in view: duplicate metadata, orphaned and
 * weakly-linked pages, and internal links pointing at broken URLs.
 */
function crossPageFindings(
  rows: PageRow[],
  indexable: PageRow[],
  inbound: Map<string, number>,
): Array<Finding & { pageId: string | null; url: string | null }> {
  const out: Array<Finding & { pageId: string | null; url: string | null }> = [];

  // --- Duplicate titles / descriptions (indexable pages only: duplicate
  // metadata on a noindexed or redirecting page is not a ranking problem) ---
  for (const [field, label] of [
    ["title", "title"],
    ["metaDescription", "meta description"],
  ] as const) {
    const groups = new Map<string, PageRow[]>();
    for (const row of indexable) {
      const value = row[field];
      if (!value) continue;
      const key = value.trim().toLowerCase();
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }
    for (const [value, group] of groups) {
      if (group.length < 2) continue;
      for (const row of group) {
        out.push({
          type: field === "title" ? "title.duplicate" : "description.duplicate",
          severity: "warning",
          risk: "medium",
          autoFixable: true,
          message: `Duplicate ${label} shared with ${group.length - 1} other page(s).`,
          detail: { value: value.slice(0, 200), count: group.length, urls: group.slice(0, 5).map((r) => r.url) },
          pageId: row.id,
          url: row.url,
        });
      }
    }
  }

  // --- Duplicate content ---
  const byHash = new Map<string, PageRow[]>();
  for (const row of indexable) {
    if (!row.contentHash || (row.wordCount ?? 0) === 0) continue;
    const bucket = byHash.get(row.contentHash);
    if (bucket) bucket.push(row);
    else byHash.set(row.contentHash, [row]);
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      out.push({
        type: "content.duplicate",
        severity: "warning",
        risk: "high",
        autoFixable: false,
        message: `Identical content served at ${group.length} URLs.`,
        detail: { count: group.length, urls: group.slice(0, 6).map((r) => r.url) },
        pageId: row.id,
        url: row.url,
      });
    }
  }

  // --- Orphan / weakly linked ---
  for (const row of indexable) {
    // Depth 0 is the entry point; it has no inbound links by definition.
    if (row.depth === 0) continue;
    const count = inbound.get(row.normalizedUrl) ?? 0;
    if (count === 0) {
      out.push({
        type: "links.orphan_page",
        severity: "warning",
        risk: "medium",
        autoFixable: false,
        message: "No internal links point to this page — only reachable via the sitemap.",
        pageId: row.id,
        url: row.url,
      });
    } else if (count <= WEAK_INBOUND_LINKS) {
      out.push({
        type: "links.weakly_linked",
        severity: "notice",
        risk: "low",
        autoFixable: false,
        message: `Only ${count} internal link points here — likely under-prioritised.`,
        detail: { inboundLinkCount: count },
        pageId: row.id,
        url: row.url,
      });
    }
  }

  // --- Broken internal links ---
  // Built from crawled outcomes, so it only reports targets we actually
  // fetched and saw fail; uncrawled URLs are never guessed at.
  const brokenTargets = new Map<string, number>();
  for (const row of rows) {
    if (row.httpStatus !== null && row.httpStatus >= 400) brokenTargets.set(row.normalizedUrl, row.httpStatus);
    else if (row.httpStatus === null) brokenTargets.set(row.normalizedUrl, 0);
  }

  for (const row of rows) {
    const source = row.finalUrl ?? row.url;
    const hits: BrokenLinkHit[] = [];

    for (const link of row.internalLinks ?? []) {
      const normalized = normalizePageUrl(link.url, source);
      if (!normalized) continue;
      // A broken page linking to itself is not an actionable finding, and
      // on a 404 template it would fire for every single error page.
      if (normalized.normalizedUrl === row.normalizedUrl) continue;

      const status = brokenTargets.get(normalized.normalizedUrl);
      if (status === undefined) continue;

      hits.push({
        url: link.url,
        status,
        // The evidence that makes this fixable: which anchor, and where in
        // the markup it sits.
        anchor: link.anchor ?? null,
        selector: link.selector ?? null,
        snippet: link.snippet ?? null,
        occurrences: link.count,
      });
    }

    if (hits.length > 0) {
      out.push({
        type: "links.broken_internal",
        severity: "critical",
        risk: "low",
        autoFixable: false,
        message:
          hits.length === 1
            ? `Broken link: ${hits[0].anchor ? `"${hits[0].anchor}"` : hits[0].url} → ${hits[0].status || "no response"}`
            : `Links to ${hits.length} broken internal URLs.`,
        detail: { count: hits.length, targets: hits.slice(0, MAX_STORED_BROKEN_TARGETS) },
        pageId: row.id,
        url: row.url,
      });
    }
  }

  return out;
}
