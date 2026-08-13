import * as cheerio from "cheerio";
import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { pages } from "../db/schema.js";
import { extractSeoContent } from "./extractSeoContent.js";

// Browsers are heavy (memory, CPU, one OS process each) compared to the
// plain HTTP requests Stage 1 makes, so this stays deliberately small --
// this pass only ever runs against the (typically small) subset of pages
// Stage 1 flagged, never the whole crawl.
/**
 * Overridable, and the single biggest knob on a developer machine: each unit
 * is a full headless Chrome process with its own CPU and several hundred MB
 * of RAM. Setting this to 1 roughly halves the crawl's footprint at the cost
 * of a slower Stage 2.
 */
const RENDER_MAX_CONCURRENCY = Number(process.env.RENDER_MAX_CONCURRENCY) || 2;
const NAVIGATION_TIMEOUT_SECS = 30;
const REQUEST_HANDLER_TIMEOUT_SECS = 45;
const MAX_RETRIES = 1;
// Lets client-rendered content settle before reading the DOM, without
// letting a page with persistent background activity (polling, websockets,
// analytics beacons) hold the browser open indefinitely.
const NETWORK_IDLE_TIMEOUT_MS = 10_000;

export interface FlaggedPage {
  url: string;
  normalizedUrl: string;
}

export interface RenderPagesResult {
  rendered: number;
  failed: number;
}

/**
 * Stage 2 of content extraction. Re-visits pages Stage 1 flagged as likely
 * unrendered JS shells, this time with a real browser, and overwrites their
 * stored SEO content with what a user's browser would actually see.
 *
 * Runs as its own isolated queue and crawler instance so it never competes
 * with, slows down, or shares failure modes with the main discovery crawl.
 * A failure here only affects content accuracy for the flagged pages --
 * discovery, status codes, and redirect data from Stage 1 are already
 * safely persisted regardless of how this stage goes.
 */
export async function renderFlaggedPages(
  crawlId: string,
  flagged: FlaggedPage[],
  siteHosts: Set<string>,
): Promise<RenderPagesResult> {
  const result: RenderPagesResult = { rendered: 0, failed: 0 };
  if (flagged.length === 0) return result;

  const queue = await RequestQueue.open(`${crawlId}-render`);
  for (const page of flagged) {
    await queue.addRequest({ url: page.url, uniqueKey: page.normalizedUrl });
  }

  const crawler = new PlaywrightCrawler({
    requestQueue: queue,
    maxConcurrency: RENDER_MAX_CONCURRENCY,
    navigationTimeoutSecs: NAVIGATION_TIMEOUT_SECS,
    requestHandlerTimeoutSecs: REQUEST_HANDLER_TIMEOUT_SECS,
    maxRequestRetries: MAX_RETRIES,
    launchContext: { launchOptions: { headless: true } },

    async requestHandler({ request, page }) {
      const startedAt = Date.now();
      await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {
        // Some pages never go fully idle (polling, websockets) -- proceed
        // with whatever has rendered by the timeout rather than fail the page.
      });

      const html = await page.content();
      const loadTimeMs = Date.now() - startedAt;
      const content = extractSeoContent(cheerio.load(html), { pageUrl: page.url(), siteHosts });

      // Overwrites every HTML-derived field, not just the obvious ones: the
      // whole point of this stage is that Stage 1's values came from an
      // unrendered shell, so its link graph and body text are just as wrong
      // as its title. htmlBytes/responseTimeMs are deliberately left alone --
      // those describe the original HTTP fetch, which is still accurate.
      await db
        .update(pages)
        .set({
          title: content.title,
          metaDescription: content.metaDescription,
          canonicalUrl: content.canonicalUrl,
          robotsMeta: content.robotsMeta,
          headings: content.headings,
          images: content.images,
          structuredData: content.structuredData,
          wordCount: content.wordCount,
          contentText: content.contentText,
          contentHash: content.contentHash,
          internalLinks: content.internalLinks,
          externalLinks: content.externalLinks,
          internalLinkCount: content.internalLinkCount,
          externalLinkCount: content.externalLinkCount,
          noindex: content.noindex,
          nofollow: content.nofollow,
          scripts: content.scripts,
          scriptCount: content.scriptCount,
          inlineScriptCount: content.inlineScriptCount,
          blockingScriptCount: content.blockingScriptCount,
          thirdPartyOrigins: content.thirdPartyOrigins,
          openGraph: content.openGraph,
          lang: content.lang,
          viewport: content.viewport,
          hreflang: content.hreflang,
          loadTimeMs,
          renderMethod: "browser",
        })
        .where(and(eq(pages.crawlId, crawlId), eq(pages.normalizedUrl, request.uniqueKey ?? request.url)));

      result.rendered += 1;
    },

    async failedRequestHandler() {
      result.failed += 1;
    },
  });

  await crawler.run();
  // Cleanup only -- a failure here must not lose a completed render pass.
  await queue.drop().catch((err) => console.warn("[render] queue cleanup failed (harmless):", err?.message ?? err));
  return result;
}
