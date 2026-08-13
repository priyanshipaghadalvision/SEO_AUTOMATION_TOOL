import type { Heading, PageImage, SiteAudit, StructuredDataItem } from "../db/schema.js";

export type Severity = "critical" | "warning" | "notice";
export type Risk = "low" | "medium" | "high";

export interface Finding {
  type: string;
  severity: Severity;
  risk: Risk;
  autoFixable: boolean;
  message: string;
  detail?: Record<string, unknown>;
}

/**
 * Everything a per-page rule is allowed to look at. Deliberately a plain
 * data shape rather than the Drizzle row type: rules stay pure and unit
 * testable, and can't reach back into the database mid-evaluation.
 */
export interface PageFacts {
  id: string;
  url: string;
  finalUrl: string | null;
  httpStatus: number | null;
  redirectChain: string[] | null;
  errorMessage: string | null;
  depth: number;
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
  nofollow: boolean;
  headings: Heading[];
  images: PageImage[];
  structuredData: StructuredDataItem[];
  wordCount: number;
  internalLinkCount: number;
  externalLinkCount: number;
  inboundLinkCount: number;
  blockingScriptCount: number;
  htmlBytes: number | null;
  responseTimeMs: number | null;
}

// Thresholds. Centralised so the numbers behind every verdict are visible
// and adjustable in one place rather than scattered through the rules.
export const TITLE_MIN = 30;
export const TITLE_MAX = 60;
export const DESC_MIN = 70;
export const DESC_MAX = 160;
/** Google's own guidance is to keep links per page to a reasonable number. */
export const EXCESSIVE_LINKS = 300;
/** At or below this many inbound links a page is hard for crawlers to reach. */
export const WEAK_INBOUND_LINKS = 1;
export const THIN_CONTENT_WORDS = 250;
export const SLOW_RESPONSE_MS = 1500;
export const LARGE_PAGE_BYTES = 2_000_000;

/**
 * All findings for a single page.
 *
 * Rules that need cross-page context (duplicate titles, orphan pages,
 * broken internal links) are NOT here -- they live in analyzeCrawl, because
 * they can only be decided once every page is known.
 */
export function analyzePage(page: PageFacts): Finding[] {
  const out: Finding[] = [];

  // ---- HTTP status ----
  const status = page.httpStatus;
  if (status === null) {
    out.push({
      type: "http.request_failed",
      severity: "critical",
      risk: "high",
      autoFixable: false,
      message: `Request failed: ${page.errorMessage ?? "no response"}`,
    });
    // Nothing else can be judged about a page that never responded.
    return out;
  }

  if (status === 404 || status === 410) {
    out.push({
      type: "http.not_found",
      severity: "critical",
      risk: "medium",
      autoFixable: false,
      message: `Returns ${status} — the page is gone but is still being linked to.`,
    });
  } else if (status >= 500) {
    out.push({
      type: "http.server_error",
      severity: "critical",
      risk: "high",
      autoFixable: false,
      message: `Server error ${status}.`,
    });
  } else if (status >= 400) {
    out.push({
      type: "http.client_error",
      severity: "warning",
      risk: "medium",
      autoFixable: false,
      message: `Client error ${status}.`,
    });
  }

  const hops = page.redirectChain?.length ?? 0;
  if (hops >= 2) {
    out.push({
      type: "http.redirect_chain",
      severity: "warning",
      risk: "medium",
      autoFixable: true,
      message: `${hops} redirect hops before the final URL — link directly to the destination.`,
      detail: { chain: page.redirectChain },
    });
  }
  // A loop shows up as the same URL appearing twice in the chain.
  if (page.redirectChain && new Set(page.redirectChain).size !== page.redirectChain.length) {
    out.push({
      type: "http.redirect_loop",
      severity: "critical",
      risk: "high",
      autoFixable: false,
      message: "Redirect loop detected.",
      detail: { chain: page.redirectChain },
    });
  }

  // A non-200 page has no meaningful content to audit further.
  if (status >= 300) return out;

  // ---- Indexability ----
  if (page.noindex) {
    out.push({
      type: "index.noindex",
      severity: "warning",
      risk: "high",
      autoFixable: false,
      message: "Marked noindex — excluded from search results.",
    });
  }

  // ---- Title ----
  if (!page.title) {
    out.push({
      type: "title.missing",
      severity: "critical",
      risk: "medium",
      autoFixable: true,
      message: "Missing title tag.",
      detail: { pageUrl: page.finalUrl ?? page.url },
    });
  } else if (page.title.length < TITLE_MIN) {
    out.push({
      type: "title.too_short",
      severity: "warning",
      risk: "medium",
      autoFixable: true,
      message: `Title is ${page.title.length} chars — under the ${TITLE_MIN} recommended minimum.`,
      detail: { title: page.title, length: page.title.length },
    });
  } else if (page.title.length > TITLE_MAX) {
    out.push({
      type: "title.too_long",
      severity: "notice",
      risk: "medium",
      autoFixable: true,
      message: `Title is ${page.title.length} chars — likely truncated past ${TITLE_MAX}.`,
      detail: { title: page.title, length: page.title.length },
    });
  }

  // ---- Meta description ----
  if (!page.metaDescription) {
    out.push({
      type: "description.missing",
      severity: "warning",
      risk: "low",
      autoFixable: true,
      message: "Missing meta description.",
      detail: { pageUrl: page.finalUrl ?? page.url },
    });
  } else if (page.metaDescription.length < DESC_MIN) {
    out.push({
      type: "description.too_short",
      severity: "notice",
      risk: "low",
      autoFixable: true,
      message: `Description is ${page.metaDescription.length} chars — under ${DESC_MIN}.`,
      detail: { value: page.metaDescription, length: page.metaDescription.length },
    });
  } else if (page.metaDescription.length > DESC_MAX) {
    out.push({
      type: "description.too_long",
      severity: "notice",
      risk: "low",
      autoFixable: true,
      message: `Description is ${page.metaDescription.length} chars — truncated past ${DESC_MAX}.`,
      detail: { value: page.metaDescription, length: page.metaDescription.length },
    });
  }

  // ---- Canonical ----
  if (!page.canonicalUrl) {
    out.push({
      type: "canonical.missing",
      severity: "warning",
      risk: "medium",
      autoFixable: true,
      message: "No canonical tag — duplicate URLs of this page can't be consolidated.",
    });
  } else if (!sameUrl(page.canonicalUrl, page.finalUrl ?? page.url)) {
    out.push({
      type: "canonical.not_self",
      severity: "notice",
      risk: "high",
      autoFixable: false,
      message: "Canonical points elsewhere — this URL may be dropped from the index.",
      detail: { canonical: page.canonicalUrl, pageUrl: page.finalUrl ?? page.url },
    });
  }

  // ---- Headings ----
  const h1s = page.headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    out.push({
      type: "heading.h1_missing",
      severity: "warning",
      risk: "medium",
      autoFixable: true,
      message: "No H1 heading.",
    });
  } else if (h1s.length > 1) {
    out.push({
      type: "heading.h1_multiple",
      severity: "notice",
      risk: "medium",
      autoFixable: false,
      message: `${h1s.length} H1 tags — a page should have exactly one.`,
      detail: {
        count: h1s.length,
        headings: h1s.slice(0, 5).map((h) => ({ text: h.text, selector: h.selector ?? null })),
      },
    });
  }

  // Records the headings either side of each gap, not just "H2->H4": the
  // text is what lets someone find the spot in the page.
  const skips = [] as Array<{ gap: string; after: string; before: string; selector?: string | null }>;
  for (let i = 1; i < page.headings.length; i++) {
    const prev = page.headings[i - 1];
    const curr = page.headings[i];
    if (curr.level > prev.level + 1) {
      skips.push({
        gap: `H${prev.level}→H${curr.level}`,
        after: prev.text,
        before: curr.text,
        selector: curr.selector ?? null,
      });
    }
  }
  if (skips.length > 0) {
    out.push({
      type: "heading.hierarchy_skip",
      severity: "notice",
      risk: "medium",
      autoFixable: false,
      message: `Heading levels skipped (${skips.slice(0, 3).map((s) => s.gap).join(", ")}) — breaks the document outline.`,
      detail: { skips: skips.slice(0, 10) },
    });
  }

  // ---- Images ----
  const noAlt = page.images.filter((i) => i.alt === null);
  if (noAlt.length > 0) {
    out.push({
      type: "image.alt_missing",
      severity: "warning",
      risk: "low",
      autoFixable: true,
      message: `${noAlt.length} of ${page.images.length} images have no alt attribute.`,
      detail: {
        count: noAlt.length,
        total: page.images.length,
        examples: noAlt.slice(0, 5).map((i) => ({ src: i.src, selector: i.selector, snippet: i.snippet })),
      },
    });
  }
  const noDims = page.images.filter((i) => i.width === null || i.height === null);
  if (noDims.length > 0) {
    out.push({
      type: "image.dimensions_missing",
      severity: "notice",
      risk: "low",
      autoFixable: true,
      message: `${noDims.length} images lack width/height — causes layout shift (CLS).`,
      detail: {
        count: noDims.length,
        examples: noDims.slice(0, 5).map((i) => ({
          src: i.src,
          width: i.width,
          height: i.height,
          selector: i.selector,
        })),
      },
    });
  }

  // ---- Structured data ----
  if (page.structuredData.length === 0) {
    out.push({
      type: "schema.missing",
      severity: "notice",
      risk: "medium",
      autoFixable: true,
      message: "No JSON-LD structured data.",
    });
  } else {
    const invalid = page.structuredData.filter((item) => !item["@context"] || !item["@type"]);
    if (invalid.length > 0) {
      out.push({
        type: "schema.invalid",
        severity: "warning",
        risk: "medium",
        autoFixable: true,
        message: `${invalid.length} schema block(s) missing @context or @type.`,
        detail: { count: invalid.length },
      });
    }
  }

  // ---- Content ----
  if (page.wordCount < THIN_CONTENT_WORDS) {
    out.push({
      type: "content.thin",
      severity: "notice",
      risk: "high",
      autoFixable: false,
      message: `Only ${page.wordCount} words — thin content is unlikely to rank.`,
      detail: { wordCount: page.wordCount },
    });
  }

  // ---- Links ----
  if (page.internalLinkCount > EXCESSIVE_LINKS) {
    out.push({
      type: "links.excessive",
      severity: "notice",
      risk: "medium",
      autoFixable: false,
      message: `${page.internalLinkCount} internal links — dilutes the value passed by each.`,
      detail: { count: page.internalLinkCount },
    });
  }

  // ---- Performance ----
  if (page.responseTimeMs !== null && page.responseTimeMs > SLOW_RESPONSE_MS) {
    out.push({
      type: "perf.slow_response",
      severity: "warning",
      risk: "high",
      autoFixable: false,
      message: `Server took ${page.responseTimeMs}ms to respond.`,
      detail: { responseTimeMs: page.responseTimeMs },
    });
  }
  if (page.htmlBytes !== null && page.htmlBytes > LARGE_PAGE_BYTES) {
    out.push({
      type: "perf.large_html",
      severity: "notice",
      risk: "medium",
      autoFixable: false,
      message: `HTML is ${(page.htmlBytes / 1024 / 1024).toFixed(1)}MB before assets.`,
      detail: { htmlBytes: page.htmlBytes },
    });
  }
  if (page.blockingScriptCount > 0) {
    out.push({
      type: "perf.render_blocking_js",
      severity: "notice",
      risk: "medium",
      autoFixable: true,
      message: `${page.blockingScriptCount} render-blocking script(s) — add async or defer.`,
      detail: { count: page.blockingScriptCount },
    });
  }

  return out;
}

/** Site-wide findings derived from the crawl's robots/sitemap audit. */
export function analyzeSite(audit: SiteAudit | null): Finding[] {
  const out: Finding[] = [];
  if (!audit) return out;

  if (!audit.robots.found) {
    out.push({
      type: "site.robots_missing",
      severity: "notice",
      risk: "high",
      autoFixable: true,
      message: `No robots.txt (status ${audit.robots.status ?? "no response"}).`,
      detail: { url: audit.robots.url, status: audit.robots.status },
    });
  }
  if (audit.robots.blocksEverything) {
    out.push({
      type: "site.robots_blocks_all",
      severity: "critical",
      risk: "high",
      autoFixable: false,
      message: "robots.txt blocks crawling of the homepage.",
    });
  }
  if (!audit.sitemap.found) {
    out.push({
      type: "site.sitemap_missing",
      severity: "warning",
      risk: "high",
      autoFixable: true,
      message: "No XML sitemap found — search engines must rely on links alone.",
      detail: { checked: audit.sitemap.locations },
    });
  }

  return out;
}

/** Trailing-slash and case insensitive URL comparison. */
export function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
