import { DESC_MAX, DESC_MIN, TITLE_MAX, TITLE_MIN } from "../analysis/rules.js";
import type {
  OptimizationDraft,
  OptimizationPageContext,
  OptimizationProvider,
  OptimizationTask,
  ProviderResult,
  SiteContext,
} from "./types.js";
import {
  altFromFilename,
  brandFromDomain,
  escapeXml,
  extractProseSummary,
  shortenTitleKeepingBrand,
  summariseToLength,
  titleFromUrlSlug,
  truncateAtWord,
} from "./text.js";

/** Never emit more than this many alt-text proposals for one page. */
const MAX_ALT_PER_PAGE = 20;
/** Sitemaps are a starting point, not an export -- keep the sample readable. */
const MAX_SITEMAP_URLS = 200;

/**
 * Generates fixes that follow mechanically from the crawled data, with no
 * model involved.
 *
 * The point of this provider is that it always works: no API key, no network,
 * no per-run cost, and a proposal it makes is reproducible byte-for-byte. It
 * deliberately declines anything requiring judgement about what a page is
 * *about* -- rewriting a thin title, differentiating duplicate descriptions --
 * and leaves those to the AI provider. Where both can act, the orchestrator
 * prefers the AI result.
 *
 * Confidence scores are calibrated to that honesty: a self-referencing
 * canonical is 95 because it is simply correct, while alt text guessed from a
 * filename is 40 because it is a hint, not an answer.
 */
export class RuleOptimizationProvider implements OptimizationProvider {
  readonly source = "rule" as const;
  readonly model = null;

  async generate(tasks: OptimizationTask[]): Promise<ProviderResult> {
    const drafts: OptimizationDraft[] = [];
    for (const task of tasks) {
      drafts.push(...generateForTask(task));
    }
    // Pure string work against data already in hand -- there is no failure
    // mode here short of a bug, so there is nothing to report.
    return { drafts, failedPages: 0, firstError: null };
  }
}

/** Issue types this provider can produce a concrete value for. */
export const RULE_SUPPORTED_ISSUES = new Set([
  "title.missing",
  "title.too_long",
  "description.missing",
  "description.too_long",
  "canonical.missing",
  "heading.h1_missing",
  "image.alt_missing",
  "schema.missing",
  "perf.render_blocking_js",
  "http.redirect_chain",
  "site.robots_missing",
  "site.sitemap_missing",
]);

function generateForTask(task: OptimizationTask): OptimizationDraft[] {
  const { page, site } = task;

  switch (task.issueType) {
    case "site.robots_missing":
      return [robotsTxt(site)];
    case "site.sitemap_missing":
      return [sitemapXml(site)];
    default:
      break;
  }

  if (!page) return [];

  switch (task.issueType) {
    case "title.missing":
      return titleMissing(page, site);
    case "title.too_long":
      return titleTooLong(page);
    case "description.missing":
      return descriptionMissing(page);
    case "description.too_long":
      return descriptionTooLong(page);
    case "canonical.missing":
      return canonicalMissing(page);
    case "heading.h1_missing":
      return h1Missing(page);
    case "image.alt_missing":
      return imageAltMissing(page);
    case "schema.missing":
      return schemaMissing(page, site);
    case "perf.render_blocking_js":
      return deferScripts(page);
    case "http.redirect_chain":
      return redirectChain(page, task.detail);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Page-level fixes
// ---------------------------------------------------------------------------

function titleMissing(page: OptimizationPageContext, site: SiteContext): OptimizationDraft[] {
  const h1 = page.headings.find((h) => h.level === 1)?.text?.trim();
  const base = h1 && h1.length >= 5 ? h1 : titleFromUrlSlug(page.finalUrl ?? page.url);
  if (!base) return [];

  const brand = brandFromDomain(site.domain);
  const suffix = brand ? ` | ${brand}` : "";
  const head = truncateAtWord(base, Math.max(10, TITLE_MAX - suffix.length));
  const title = `${head}${suffix}`;
  if (title.length < 10) return [];

  return [
    {
      ...pageRef(page),
      issueType: "title.missing",
      action: "UPDATE_TITLE",
      target: null,
      oldValue: null,
      newValue: title,
      reason: h1
        ? `Built from the page's H1 with the site brand appended. The page currently has no <title>, so search results fall back to the URL.`
        : `Built from the URL slug with the site brand appended — the page has neither a <title> nor an H1 to work from. Review the wording before shipping.`,
      confidence: h1 ? 65 : 40,
      risk: "medium",
      source: "rule",
      model: null,
    },
  ];
}

function titleTooLong(page: OptimizationPageContext): OptimizationDraft[] {
  if (!page.title) return [];
  const shortened = shortenTitleKeepingBrand(page.title, TITLE_MAX);
  if (!shortened || shortened === page.title) return [];

  return [
    {
      ...pageRef(page),
      issueType: "title.too_long",
      action: "UPDATE_TITLE",
      target: null,
      oldValue: page.title,
      newValue: shortened,
      reason: `Trimmed from ${page.title.length} to ${shortened.length} characters at a word boundary, keeping any brand suffix, so the title stops being cut off in search results.`,
      confidence: 60,
      risk: "medium",
      source: "rule",
      model: null,
    },
  ];
}

function descriptionMissing(page: OptimizationPageContext): OptimizationDraft[] {
  if (!page.contentText) return [];
  // Prose-only: a word-boundary cut of nav-menu text reads like a description
  // but says nothing, and proposing one is worse than declining.
  const summary = extractProseSummary(page.contentText, DESC_MAX, DESC_MIN);
  if (!summary) return [];

  return [
    {
      ...pageRef(page),
      issueType: "description.missing",
      action: "UPDATE_DESCRIPTION",
      target: null,
      oldValue: null,
      newValue: summary,
      reason: `Taken from the opening prose of the page (${summary.length} chars, inside the ${DESC_MIN}-${DESC_MAX} window). It is an extract, not a written summary — read it before publishing.`,
      confidence: 45,
      risk: "low",
      source: "rule",
      model: null,
    },
  ];
}

function descriptionTooLong(page: OptimizationPageContext): OptimizationDraft[] {
  const current = page.metaDescription;
  if (!current) return [];
  const trimmed = summariseToLength(current, DESC_MAX, DESC_MIN) ?? truncateAtWord(current, DESC_MAX);
  if (trimmed.length < DESC_MIN || trimmed === current) return [];

  return [
    {
      ...pageRef(page),
      issueType: "description.too_long",
      action: "UPDATE_DESCRIPTION",
      target: null,
      oldValue: current,
      newValue: trimmed,
      reason: `Trimmed from ${current.length} to ${trimmed.length} characters, preferring whole sentences, so the snippet is no longer truncated mid-thought.`,
      confidence: 60,
      risk: "low",
      source: "rule",
      model: null,
    },
  ];
}

function canonicalMissing(page: OptimizationPageContext): OptimizationDraft[] {
  const target = page.finalUrl ?? page.url;
  return [
    {
      ...pageRef(page),
      issueType: "canonical.missing",
      action: "ADD_CANONICAL",
      target: null,
      oldValue: null,
      newValue: `<link rel="canonical" href="${target}" />`,
      reason:
        "A self-referencing canonical tells search engines this URL is the authoritative one, so query strings and alternate paths consolidate here instead of competing with it.",
      // Mechanical and near-always correct; the exception is a page that
      // genuinely should canonicalise elsewhere, which a human review catches.
      confidence: 95,
      risk: "low",
      source: "rule",
      model: null,
    },
  ];
}

function h1Missing(page: OptimizationPageContext): OptimizationDraft[] {
  const base = page.title?.trim() || titleFromUrlSlug(page.finalUrl ?? page.url);
  if (!base || base.length < 5) return [];
  // Strip a brand suffix -- an on-page heading shouldn't repeat the site name.
  const heading = base.split(/\s[|–—·»]\s/)[0]?.trim() || base;

  return [
    {
      ...pageRef(page),
      issueType: "heading.h1_missing",
      action: "ADD_H1",
      target: null,
      oldValue: null,
      newValue: `<h1>${heading}</h1>`,
      reason: page.title
        ? "Derived from the page title, with any brand suffix removed. The H1 is the main on-page signal of what a page covers, and this page has none."
        : "Derived from the URL slug — the page has neither a title nor an H1. Check the wording reads naturally on the page.",
      confidence: page.title ? 60 : 35,
      risk: "medium",
      source: "rule",
      model: null,
    },
  ];
}

function imageAltMissing(page: OptimizationPageContext): OptimizationDraft[] {
  const out: OptimizationDraft[] = [];
  for (const image of page.images) {
    if (image.alt !== null) continue;
    if (out.length >= MAX_ALT_PER_PAGE) break;

    const alt = altFromFilename(image.src);
    if (!alt) continue; // A meaningless filename is not worth a proposal.

    out.push({
      ...pageRef(page),
      issueType: "image.alt_missing",
      action: "SET_IMAGE_ALT",
      target: image.src,
      oldValue: image.snippet ?? null,
      newValue: `alt="${alt}"`,
      reason:
        "Read off the image filename, which is a hint rather than a description. Confirm it matches what the image actually shows before shipping — wrong alt text is worse for screen readers than none.",
      confidence: 40,
      risk: "low",
      source: "rule",
      model: null,
    });
  }
  return out;
}

function schemaMissing(page: OptimizationPageContext, site: SiteContext): OptimizationDraft[] {
  const url = page.finalUrl ?? page.url;
  const name = page.title?.trim() || page.headings.find((h) => h.level === 1)?.text?.trim();
  if (!name) return [];

  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name,
    url,
    isPartOf: { "@type": "WebSite", name: brandFromDomain(site.domain), url: site.origin },
  };
  if (page.metaDescription) schema.description = page.metaDescription;
  if (page.lang) schema.inLanguage = page.lang;

  return [
    {
      ...pageRef(page),
      issueType: "schema.missing",
      action: "ADD_SCHEMA",
      target: null,
      oldValue: null,
      newValue: `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`,
      reason:
        "A baseline WebPage block built from the page's own title, description and language. Replace WebPage with a more specific type (Article, Product, FAQPage) where one applies to earn richer results.",
      confidence: 70,
      risk: "low",
      source: "rule",
      model: null,
    },
  ];
}

function deferScripts(page: OptimizationPageContext): OptimizationDraft[] {
  const blocking = page.scripts.filter((s) => s.src && !s.async && !s.defer && !s.module);
  if (blocking.length === 0) return [];

  const rewritten = blocking
    .slice(0, 20)
    .map((s) => `<script src="${s.src}" defer></script>`)
    .join("\n");

  return [
    {
      ...pageRef(page),
      issueType: "perf.render_blocking_js",
      action: "DEFER_SCRIPTS",
      target: null,
      oldValue: blocking
        .slice(0, 20)
        .map((s) => `<script src="${s.src}"></script>`)
        .join("\n"),
      newValue: rewritten,
      reason: `${blocking.length} script tag(s) block the parser while they download. Adding defer keeps execution order but moves it past HTML parsing, which improves first paint. Use async instead for scripts with no dependency on the DOM or on each other.`,
      confidence: 80,
      risk: "medium",
      source: "rule",
      model: null,
    },
  ];
}

function redirectChain(
  page: OptimizationPageContext,
  detail: Record<string, unknown> | null,
): OptimizationDraft[] {
  const chain = Array.isArray(detail?.chain)
    ? (detail.chain as unknown[]).filter((v): v is string => typeof v === "string")
    : (page.redirectChain ?? []);
  const destination = page.finalUrl ?? chain[chain.length - 1];
  if (!destination || chain.length < 2) return [];

  return [
    {
      ...pageRef(page),
      issueType: "http.redirect_chain",
      action: "FIX_REDIRECT_CHAIN",
      target: page.url,
      oldValue: chain.join("\n  → "),
      newValue: destination,
      reason: `${chain.length} hops before the final URL. Point every internal link and the first redirect rule straight at the destination — each extra hop costs crawl budget and loses a little link equity.`,
      confidence: 90,
      risk: "low",
      source: "rule",
      model: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Site-level fixes
// ---------------------------------------------------------------------------

function robotsTxt(site: SiteContext): OptimizationDraft {
  const body = ["User-agent: *", "Allow: /", "", `Sitemap: ${site.origin}/sitemap.xml`].join("\n");
  return {
    pageId: null,
    url: `${site.origin}/robots.txt`,
    issueType: "site.robots_missing",
    action: "ADD_ROBOTS_TXT",
    target: "/robots.txt",
    oldValue: null,
    newValue: body,
    reason:
      "A permissive robots.txt that declares the sitemap. Without the file, crawlers get a 404 on every visit and have no pointer to the sitemap. Add Disallow rules for admin, cart, and search-results paths before deploying.",
    confidence: 85,
    risk: "medium",
    source: "rule",
    model: null,
  };
}

function sitemapXml(site: SiteContext): OptimizationDraft {
  const urls = site.sampleUrls.slice(0, MAX_SITEMAP_URLS);
  const entries = urls.map((u) => `  <url>\n    <loc>${escapeXml(u)}</loc>\n  </url>`).join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>`;

  return {
    pageId: null,
    url: `${site.origin}/sitemap.xml`,
    issueType: "site.sitemap_missing",
    action: "ADD_SITEMAP",
    target: "/sitemap.xml",
    oldValue: null,
    newValue: body,
    reason: `Generated from the ${urls.length} indexable URL(s) this crawl reached — that is a starting point, not the full site. Generate the real sitemap from your CMS or router so new pages are included automatically, and add <lastmod> dates.`,
    confidence: 60,
    risk: "medium",
    source: "rule",
    model: null,
  };
}

function pageRef(page: OptimizationPageContext) {
  return { pageId: page.id, url: page.finalUrl ?? page.url };
}
