import { createHash } from "node:crypto";
import type { AnyNode, CheerioAPI, Element } from "cheerio";
import { isTag } from "domhandler";
import type {
  Heading,
  HreflangEntry,
  PageImage,
  PageLink,
  PageScript,
  SocialMeta,
  StructuredDataItem,
} from "../db/schema.js";

export interface ExtractedSeoContent {
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  robotsMeta: string | null;
  headings: Heading[];
  images: PageImage[];
  structuredData: StructuredDataItem[];
  wordCount: number;
  contentText: string;
  contentHash: string;
  internalLinks: PageLink[];
  externalLinks: PageLink[];
  internalLinkCount: number;
  externalLinkCount: number;
  noindex: boolean;
  nofollow: boolean;
  scripts: PageScript[];
  scriptCount: number;
  inlineScriptCount: number;
  blockingScriptCount: number;
  thirdPartyOrigins: string[];
  openGraph: SocialMeta;
  lang: string | null;
  viewport: string | null;
  hreflang: HreflangEntry[];
}

// Hard ceilings so one pathological page (a 5000-link sitemap page, a
// machine-generated schema dump) can never bloat a row, slow extraction, or
// balloon the database. Counts are always recorded in full even when the
// stored list is truncated, so the caps never hide the true scale of a page.
const MAX_HEADINGS = 100;
const MAX_IMAGES = 50;
const MAX_STRUCTURED_DATA = 20;
const MAX_INTERNAL_LINKS = 300;
const MAX_EXTERNAL_LINKS = 100;
const MAX_SOCIAL_META = 40;
const MAX_HREFLANG = 50;
const MAX_SCRIPTS = 60;
const MAX_THIRD_PARTY_ORIGINS = 30;
const MAX_ANCHOR_CHARS = 200;
// Locator caps. Kept tight because these ride along on every stored link,
// image and heading -- a few hundred elements per page adds up fast.
const MAX_SELECTOR_CHARS = 150;
const MAX_SNIPPET_CHARS = 240;
const MAX_SELECTOR_DEPTH = 8;
// ~40k characters is comfortably more than any real article, keeps the row
// small enough to stay fast, and is well within an LLM context window for
// the later AI stages that consume this text.
const MAX_CONTENT_CHARS = 40_000;

// Below this word count on the HTTP-fetched HTML, a page is treated as a
// likely unrendered JS shell rather than genuinely thin content -- see
// needsBrowserRender() below.
const MIN_WORD_COUNT_FOR_HTTP_CONFIDENCE = 80;

export interface ExtractOptions {
  /** Absolute URL of the page, used to resolve relative hrefs. */
  pageUrl: string;
  /** Hostnames considered part of this site; anything else is an external link. */
  siteHosts: Set<string>;
  /** Raw X-Robots-Tag response header, which can carry noindex/nofollow too. */
  xRobotsTag?: string | null;
}

/**
 * Extracts every SEO-relevant field from an already-parsed HTML document.
 *
 * Pure and source-agnostic: the same function runs whether `$` came from a
 * raw HTTP response (cheap, Stage 1) or `page.content()` after full browser
 * rendering (Stage 2), so extraction logic is never duplicated. It performs
 * no I/O -- everything here is derived from HTML already in memory, which is
 * why capturing this much extra data costs no additional requests to the
 * target site.
 */
export function extractSeoContent($: CheerioAPI, options: ExtractOptions): ExtractedSeoContent {
  const { pageUrl, siteHosts, xRobotsTag } = options;

  const title = $("title").first().text().trim() || null;
  const metaDescription = normalizeAttr($('meta[name="description"]').attr("content"));
  const robotsMeta = normalizeAttr($('meta[name="robots"]').attr("content"));
  const canonicalUrl = resolveUrl($('link[rel="canonical"]').attr("href"), pageUrl);
  const lang = normalizeAttr($("html").attr("lang"));
  const viewport = normalizeAttr($('meta[name="viewport"]').attr("content"));

  // Indexability comes from the meta tag AND the response header; a page is
  // noindexed if either says so, and checking only one is a common source of
  // false "indexable" verdicts.
  const robotsDirectives = `${robotsMeta ?? ""},${xRobotsTag ?? ""}`.toLowerCase();
  const noindex = /\bnoindex\b/.test(robotsDirectives);
  const nofollow = /\bnofollow\b/.test(robotsDirectives);

  const headings: Heading[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    if (headings.length >= MAX_HEADINGS) return false;
    const text = $(el).text().trim();
    if (text) {
      headings.push({
        level: Number(el.tagName.slice(1)),
        text: text.slice(0, 300),
        selector: cssPath($, el),
      });
    }
  });

  const images: PageImage[] = [];
  $("img").each((_, el) => {
    if (images.length >= MAX_IMAGES) return false;
    const src = resolveUrl($(el).attr("src"), pageUrl);
    if (!src) return;
    images.push({
      src,
      alt: normalizeAttr($(el).attr("alt")),
      width: parseNumericAttr($(el).attr("width")),
      height: parseNumericAttr($(el).attr("height")),
      loading: normalizeAttr($(el).attr("loading")),
      ...locate($, el),
    });
  });

  const structuredData: StructuredDataItem[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    if (structuredData.length >= MAX_STRUCTURED_DATA) return false;
    try {
      const parsed: unknown = JSON.parse($(el).html() ?? "");
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (structuredData.length >= MAX_STRUCTURED_DATA) break;
        if (item && typeof item === "object") structuredData.push(item as StructuredDataItem);
      }
    } catch {
      // Malformed JSON-LD is common in the wild -- skip rather than fail the page.
    }
  });

  const openGraph: SocialMeta = {};
  $("meta[property], meta[name]").each((_, el) => {
    if (Object.keys(openGraph).length >= MAX_SOCIAL_META) return false;
    const key = ($(el).attr("property") ?? $(el).attr("name") ?? "").toLowerCase();
    if (!key.startsWith("og:") && !key.startsWith("twitter:") && !key.startsWith("article:")) return;
    const value = normalizeAttr($(el).attr("content"));
    if (value && !(key in openGraph)) openGraph[key] = value.slice(0, 500);
  });

  const hreflang: HreflangEntry[] = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    if (hreflang.length >= MAX_HREFLANG) return false;
    const langAttr = normalizeAttr($(el).attr("hreflang"));
    const href = resolveUrl($(el).attr("href"), pageUrl);
    if (langAttr && href) hreflang.push({ lang: langAttr, href });
  });

  const links = extractLinks($, pageUrl, siteHosts);
  const js = extractScripts($, pageUrl, siteHosts);

  // Text content: strip anything non-visible, then collapse whitespace once.
  // The hash is taken over the FULL normalised text (before truncation) so
  // two long pages that differ only past the 40k mark aren't reported as
  // duplicates.
  const bodyClone = $("body").clone();
  bodyClone.find("script, style, noscript, template, svg").remove();
  const fullText = bodyClone.text().replace(/\s+/g, " ").trim();
  const wordCount = fullText ? fullText.split(" ").length : 0;
  const contentHash = createHash("sha256").update(fullText.toLowerCase()).digest("hex");

  return {
    title,
    metaDescription,
    canonicalUrl,
    robotsMeta,
    headings,
    images,
    structuredData,
    wordCount,
    contentText: fullText.slice(0, MAX_CONTENT_CHARS),
    contentHash,
    ...links,
    ...js,
    noindex,
    nofollow,
    openGraph,
    lang,
    viewport,
    hreflang,
  };
}

/**
 * Splits every <a href> into internal vs external, deduplicated by target.
 *
 * Deduplication matters a lot here: a typical page links its own nav 30+
 * times, so storing raw occurrences would multiply the link graph's size for
 * no analytical gain. Keeping a `count` instead preserves the signal (how
 * strongly A points at B) at a fraction of the size.
 */
function extractLinks(
  $: CheerioAPI,
  pageUrl: string,
  siteHosts: Set<string>,
): Pick<
  ExtractedSeoContent,
  "internalLinks" | "externalLinks" | "internalLinkCount" | "externalLinkCount"
> {
  const internal = new Map<string, PageLink>();
  const external = new Map<string, PageLink>();
  let internalTotal = 0;
  let externalTotal = 0;

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const resolved = resolveUrl(href, pageUrl);
    if (!resolved) return;

    let hostname: string;
    try {
      const parsed = new URL(resolved);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return; // mailto:, tel:, javascript:
      hostname = parsed.hostname.toLowerCase();
    } catch {
      return;
    }

    const rel = ($(el).attr("rel") ?? "").toLowerCase();
    const isInternal = siteHosts.has(hostname);
    const bucket = isInternal ? internal : external;
    const cap = isInternal ? MAX_INTERNAL_LINKS : MAX_EXTERNAL_LINKS;

    if (isInternal) internalTotal += 1;
    else externalTotal += 1;

    const existing = bucket.get(resolved);
    if (existing) {
      existing.count += 1;
      return;
    }
    if (bucket.size >= cap) return;

    bucket.set(resolved, {
      url: resolved,
      anchor: $(el).text().trim().slice(0, MAX_ANCHOR_CHARS) || null,
      nofollow: /\bnofollow\b/.test(rel),
      count: 1,
      // Locator of the FIRST occurrence: when the same target is linked
      // several times, one concrete place to look is enough to fix it.
      ...locate($, el),
    });
  });

  return {
    internalLinks: [...internal.values()],
    externalLinks: [...external.values()],
    internalLinkCount: internalTotal,
    externalLinkCount: externalTotal,
  };
}

/**
 * Profiles the page's JavaScript.
 *
 * "Blocking" means a classic external script with neither async nor defer --
 * the browser must stop parsing HTML to fetch and run it, which is the
 * single most common render-blocking pattern. Third-party origins are
 * collected separately because they're both a performance cost and the
 * clearest signal of which external services a page depends on.
 */
function extractScripts(
  $: CheerioAPI,
  pageUrl: string,
  siteHosts: Set<string>,
): Pick<
  ExtractedSeoContent,
  "scripts" | "scriptCount" | "inlineScriptCount" | "blockingScriptCount" | "thirdPartyOrigins"
> {
  const scripts: PageScript[] = [];
  const thirdParty = new Set<string>();
  let total = 0;
  let inline = 0;
  let blocking = 0;

  $("script").each((_, el) => {
    const type = ($(el).attr("type") ?? "").toLowerCase();
    // JSON-LD and other data blocks are markup, not executable script --
    // counting them here would badly inflate the JS profile of any page
    // with rich structured data.
    if (type && type !== "module" && type !== "text/javascript" && type !== "application/javascript") return;

    total += 1;
    const rawSrc = $(el).attr("src");
    const src = resolveUrl(rawSrc, pageUrl);
    const isAsync = $(el).attr("async") !== undefined;
    const isDefer = $(el).attr("defer") !== undefined;
    const isModule = type === "module";

    if (!rawSrc) {
      inline += 1;
    } else {
      // Modules are deferred by definition, so they never block parsing.
      if (!isAsync && !isDefer && !isModule) blocking += 1;
      if (src) {
        try {
          const host = new URL(src).hostname.toLowerCase();
          if (!siteHosts.has(host)) thirdParty.add(host);
        } catch {
          /* unparseable src -- ignore for origin purposes */
        }
      }
    }

    if (scripts.length < MAX_SCRIPTS) {
      scripts.push({
        src,
        async: isAsync,
        defer: isDefer,
        module: isModule,
        inlineBytes: rawSrc ? 0 : Buffer.byteLength($(el).html() ?? ""),
      });
    }
  });

  return {
    scripts,
    scriptCount: total,
    inlineScriptCount: inline,
    blockingScriptCount: blocking,
    thirdPartyOrigins: [...thirdParty].slice(0, MAX_THIRD_PARTY_ORIGINS),
  };
}

/**
 * Heuristic for the HTTP-first/browser-fallback policy. Triggers a browser
 * re-render if EITHER the title is missing OR the body is thin -- checked
 * independently, not combined, because they catch two different failure
 * modes:
 *   - No title at all: a strong, standalone signal of an unrendered shell.
 *   - Title present but body word count is low: still very likely a shell,
 *     since most SPA frameworks (React/Vue/Next.js client-rendered apps)
 *     hardcode a static <title> in their HTML template while the actual
 *     content only exists after JS executes -- this is the single most
 *     common real-world shape of "looks fine, is actually empty" and would
 *     be missed entirely by a title-only check.
 * A false positive here (re-rendering a genuinely thin static page, e.g. a
 * short "page moved" notice) costs a few seconds of browser time on one
 * page. A false negative -- treating a real SPA shell as done -- silently
 * stores empty/garbage content, which is the exact failure Phase 3 exists
 * to prevent. The tradeoff is deliberately asymmetric in favor of re-checking.
 */
export function needsBrowserRender(content: ExtractedSeoContent): boolean {
  return !content.title || content.wordCount < MIN_WORD_COUNT_FOR_HTTP_CONFIDENCE;
}

/**
 * A CSS path to the element, e.g. "main > div:nth-of-type(2) > a:nth-of-type(3)".
 *
 * Stops early at the first ancestor carrying an id, since that alone is
 * unique and keeps the path short. Depth-capped so a deeply nested node in a
 * div-soup layout can't produce a 40-segment selector nobody can use.
 */
function cssPath($: CheerioAPI, el: AnyNode): string | null {
  const parts: string[] = [];
  let node: AnyNode | null = el;

  while (node && isTag(node) && node.tagName.toLowerCase() !== "body" && parts.length < MAX_SELECTOR_DEPTH) {
    const id = node.attribs?.id;
    if (id) {
      parts.unshift(`#${id}`);
      break;
    }

    const tag = node.tagName.toLowerCase();
    const parent: AnyNode | null = node.parent as AnyNode | null;
    const siblings =
      parent && "children" in parent
        ? (parent.children as AnyNode[]).filter((c) => isTag(c) && c.tagName === (node as Element).tagName)
        : [];

    if (siblings.length > 1) {
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
    } else {
      parts.unshift(tag);
    }
    node = parent;
  }

  const path = parts.join(" > ");
  return path ? path.slice(0, MAX_SELECTOR_CHARS) : null;
}

/**
 * The element's opening tag with its attributes -- what a developer greps
 * for. Built from the attribute map rather than serialising outerHTML,
 * which for a link wrapping a whole card can be kilobytes of markup we would
 * only throw away after truncating.
 */
function openingTag(el: AnyNode): string | null {
  if (!isTag(el)) return null;
  const attrs = Object.entries(el.attribs ?? {})
    .map(([k, v]) => (v === "" ? k : `${k}="${v}"`))
    .join(" ");
  return `<${el.tagName.toLowerCase()}${attrs ? ` ${attrs}` : ""}>`.slice(0, MAX_SNIPPET_CHARS);
}

function locate($: CheerioAPI, el: AnyNode): { selector: string | null; snippet: string | null } {
  return { selector: cssPath($, el), snippet: openingTag(el) };
}

function normalizeAttr(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveUrl(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function parseNumericAttr(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
