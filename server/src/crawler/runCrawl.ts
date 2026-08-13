import { CheerioCrawler, RequestQueue, RobotsTxtFile } from "crawlee";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { crawls, pages } from "../db/schema.js";
import type { CrawlLimits, CrawlStats } from "../db/schema.js";
import { normalizePageUrl } from "../lib/url.js";
import { isNonHtmlAssetUrl, isUnsupportedContentTypeError } from "../lib/assetUrls.js";
import { loadRobotsRules, discoverSitemapUrls } from "../lib/robots.js";
import type { RobotsResult, SitemapResult } from "../lib/robots.js";
import { extractSeoContent, needsBrowserRender } from "./extractSeoContent.js";
import { renderFlaggedPages } from "./renderPages.js";
import type { FlaggedPage } from "./renderPages.js";
import { CrawlCancelledError } from "./CrawlCancelledError.js";

// Some Crawlee/got-scraping utilities (e.g. Sitemap.tryCommonNames) don't
// expose a way to pass a network timeout at all, so a slow/black-holed
// server can hang the setup phase indefinitely -- before the in-crawl
// stall watchdog even exists to catch it. This is a hard outer ceiling
// that applies regardless of what the underlying HTTP client does.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/** Response headers may arrive as a string or a repeated-header array. */
function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.join(", ") || null;
  return value?.trim() || null;
}

/**
 * Total request duration as reported by the underlying HTTP client. Read
 * defensively -- `timings` is a got extension, not part of the Node response
 * contract, so it can legitimately be absent.
 */
function responseTotalMs(response: unknown): number | null {
  const timings = (response as { timings?: { phases?: { total?: number } } })?.timings;
  const total = timings?.phases?.total;
  return typeof total === "number" && Number.isFinite(total) ? Math.round(total) : null;
}

// Politeness + resource ceilings -- keep our own load light and never
// hammer the target site, regardless of how large it is.
/**
 * Overridable because this is the main lever when the machine running the
 * crawl is also serving the UI: every concurrent fetch is a page parsed and
 * a row written, and on a laptop that competes directly with the API.
 */
const MAX_CONCURRENCY = Number(process.env.CRAWL_MAX_CONCURRENCY) || 5;

/**
 * Discards a request queue, never letting the discard fail the crawl.
 *
 * Dropping is pure cleanup -- the crawl's outcome is already decided by the
 * time any of these run. Left unguarded, a filesystem hiccup during cleanup
 * would propagate out of the success path and report a completed crawl as
 * FAILED, which is the worst possible trade: real work thrown away because
 * deleting a temporary file did not work.
 *
 * Windows makes that concrete. Its "delete-pending" directory state turns a
 * concurrent drop into an EPERM, and a crawl that fetched 900 pages would
 * have surfaced as a failure over it.
 */
async function safeDrop(queue: { drop: () => Promise<void> }, tag: string): Promise<void> {
  try {
    await queue.drop();
  } catch (err) {
    console.warn(`[crawl ${tag}] queue cleanup failed (harmless):`, err instanceof Error ? err.message : err);
  }
}
const SAME_DOMAIN_DELAY_SECS = 0.5;
const REQUEST_HANDLER_TIMEOUT_SECS = 30;
const MAX_REQUEST_RETRIES = 2;
const STATS_FLUSH_INTERVAL_MS = 2000;
// Worst case for a single request is retries * timeout (~90s). Set the
// stall threshold comfortably above that so a merely-slow crawl is never
// falsely aborted, while still bounding how long a genuinely stuck crawl
// (e.g. the underlying scheduler wedges) can hold a worker slot.
const STALL_TIMEOUT_MS = 2 * 60_000;
const STALL_CHECK_INTERVAL_MS = 15_000;
// How often a running crawl checks whether the user has cancelled it. Kept
// short so Stop feels immediate; it's a single indexed primary-key lookup.
const CANCEL_POLL_INTERVAL_MS = 2000;
// Hard ceiling on the whole setup phase (robots.txt, sitemap discovery,
// opening the on-disk queue, seeding it). The per-step timeouts below are
// the first line of defence, but they only cover the steps they wrap -- the
// seeding loop has none, and a step that blocks the event loop outright
// stops its own timer from ever firing. Neither the stall watchdog nor the
// cancellation poll is armed until setup finishes, so without this a wedged
// setup holds the worker forever and every queued crawl behind it starves.
// Observed live on both books.toscrape.com and example.org.
const SETUP_TIMEOUT_MS = 60_000;
// Bounds worst-case wall-clock/resource cost if an entire site turns out to
// be client-rendered: browser re-renders are far more expensive per-page
// than the plain HTTP discovery pass, so an all-SPA site still gets full
// discovery coverage but only a representative sample of pages get the
// browser-rendered content upgrade.
const MAX_PAGES_TO_RENDER = 30;

export interface WebsiteRow {
  id: string;
  domain: string;
}

export interface CrawlRow {
  id: string;
  websiteId: string;
  limits: CrawlLimits;
  stats: CrawlStats;
}

/**
 * Runs a single crawl to completion: seeds from the site origin + sitemap,
 * follows same-site links up to the crawl's configured limits, respects
 * robots.txt, and persists a page row (with HTTP status / redirect info)
 * for every URL visited or attempted.
 *
 * The on-disk request queue is named after the crawl ID. Resuming an
 * in-progress queue after a worker crash proved unreliable (a queue left
 * mid-write can hang indefinitely on reopen -- observed live, more than
 * once), so the worker always drops and recreates the queue before handing
 * an orphaned crawl back to this function (see recoverOrphanedCrawls in
 * worker.ts). Seeding here is still idempotent (Crawlee's uniqueKey dedup)
 * and stats still start from the crawl's last persisted values rather than
 * zero, purely as defense-in-depth in case a queue somehow survives partially
 * intact -- not because a live resume path depends on it.
 */
export async function runCrawl(website: WebsiteRow, crawl: CrawlRow): Promise<void> {
  const originUrl = `https://${website.domain}`;
  const allowedHosts = new Set(
    (crawl.limits.allowedHosts.length > 0 ? crawl.limits.allowedHosts : [website.domain]).map((h) =>
      h.toLowerCase(),
    ),
  );
  const startedAt = Date.now();
  const deadline = startedAt + crawl.limits.timeLimitMinutes * 60_000;

  // Short crawl tag + elapsed seconds on every line, so interleaved output
  // from concurrent requests still reads as one coherent timeline.
  const tag = crawl.id.slice(0, 8);
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  const log = (msg: string) => console.log(`[crawl ${tag}] ${elapsed().padStart(7)} ${msg}`);

  log(`START ${website.domain} (max ${crawl.limits.maxPages} pages, depth ${crawl.limits.maxDepth}, ` +
    `${crawl.limits.timeLimitMinutes}min limit)`);

  // Absolute deadline covering every setup step. Raced against each await
  // below so the ceiling applies to the phase as a whole, not per-step --
  // see SETUP_TIMEOUT_MS for why this exists on top of the per-step guards.
  const setupDeadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Crawl setup exceeded ${SETUP_TIMEOUT_MS / 1000}s and was abandoned.`)),
      SETUP_TIMEOUT_MS,
    );
    timer.unref();
  });
  setupDeadline.catch(() => {}); // never left unobserved on the happy path
  // Applied OUTSIDE each step's own .catch(), so a step's graceful fallback
  // can't accidentally swallow the deadline rejection.
  const untilSetupDeadline = <T>(p: Promise<T>): Promise<T> => Promise.race([p, setupDeadline]);

  log("[1/4] fetching robots.txt...");
  const robotsResult = await untilSetupDeadline(
    withTimeout(loadRobotsRules(originUrl), 15_000, "robots.txt fetch").catch((err): RobotsResult => {
      console.warn(`[crawl ${tag}] robots.txt: ${err.message} -- proceeding with permissive rules.`);
      return {
        rules: RobotsTxtFile.from(originUrl, ""),
        audit: {
          found: false,
          status: null,
          url: new URL("/robots.txt", originUrl).toString(),
          sizeBytes: 0,
          sitemapsDeclared: [],
          blocksEverything: false,
          error: err.message,
        },
      };
    }),
  );
  const robots = robotsResult.rules;
  log(
    `[1/4] robots.txt ${robotsResult.audit.found ? "FOUND" : "not found"} ` +
      `(status ${robotsResult.audit.status ?? "n/a"}, ${robotsResult.audit.sitemapsDeclared.length} sitemap(s) declared)`,
  );

  log("[2/4] discovering sitemap...");
  const sitemapResult = await untilSetupDeadline(
    withTimeout(discoverSitemapUrls(originUrl, robots), 15_000, "sitemap discovery").catch((err): SitemapResult => {
      console.warn(`[crawl ${tag}] sitemap: ${err.message} -- proceeding without sitemap seeds.`);
      return { urls: [], audit: { found: false, source: null, locations: [], urlCount: 0, error: err.message } };
    }),
  );
  const sitemapUrls = sitemapResult.urls;
  log(
    `[2/4] sitemap ${sitemapResult.audit.found ? "FOUND" : "not found"} ` +
      `via ${sitemapResult.audit.source ?? "n/a"} -- ${sitemapUrls.length} URL(s)`,
  );

  // Persisted immediately: these site-wide findings are useful even if the
  // crawl later fails or is cancelled part-way through.
  await db
    .update(crawls)
    .set({ siteAudit: { robots: robotsResult.audit, sitemap: sitemapResult.audit } })
    .where(eq(crawls.id, crawl.id));

  // Opening the on-disk queue can hang indefinitely (not just fail fast) if
  // a previous attempt at this exact crawl was killed mid-write and left its
  // queue metadata in an inconsistent state -- found live during testing.
  // Unlike robots.txt/sitemap there's no sensible permissive fallback here
  // (the queue is load-bearing), so a timeout is a hard failure: the crawl
  // is marked FAILED with a clear, actionable reason rather than hanging
  // the worker forever. A fresh "Queue new crawl" gets a brand new queue.
  log("[3/4] opening request queue...");
  const queue = await untilSetupDeadline(
    withTimeout(RequestQueue.open(crawl.id), 15_000, "request queue open").catch((err) => {
      throw new Error(
        `Could not open the crawl queue (${err.message}). Its on-disk state may be corrupted from a previous ` +
          `interrupted run -- queue a fresh crawl to retry with a clean queue.`,
      );
    }),
  );

  const stats: CrawlStats = { ...crawl.stats };
  let lastFlush = 0;
  let lastProgressAt = Date.now();
  let stalled = false;
  let cancelled = false;
  const flaggedForRender: FlaggedPage[] = [];

  async function flushStats(force = false) {
    const now = Date.now();
    if (!force && now - lastFlush < STATS_FLUSH_INTERVAL_MS) return;
    lastFlush = now;
    await db.update(crawls).set({ stats }).where(eq(crawls.id, crawl.id));
  }

  // crawlId is supplied by this closure, so callers pass everything but that.
  async function recordPage(row: Omit<typeof pages.$inferInsert, "crawlId">) {
    await db
      .insert(pages)
      .values({ crawlId: crawl.id, ...row })
      .onConflictDoNothing({ target: [pages.crawlId, pages.normalizedUrl] });
  }

  // Seed: homepage + sitemap URLs, capped by maxPages. addRequest is a no-op
  // (wasAlreadyPresent: true) if the URL is already known to the queue, so
  // stats never double-count if seeding somehow runs twice against the same
  // queue.
  // Normalised like every other URL, not passed through raw: the origin has
  // no trailing slash while an in-page link to "/" resolves with one, so an
  // un-normalised seed makes the homepage get crawled and stored twice and
  // then reported as duplicate content. Caught by the duplicate detector.
  const homepageSeed = normalizePageUrl(originUrl, originUrl);
  const homepageKey = homepageSeed?.normalizedUrl ?? originUrl;
  const homepageAdded = await untilSetupDeadline(
    queue.addRequest({
      url: homepageSeed?.url ?? originUrl,
      uniqueKey: homepageKey,
      userData: { depth: 0 },
    }),
  );
  if (!homepageAdded.wasAlreadyPresent) stats.discovered += 1;

  let seedAssetsSkipped = 0;
  const seenSeeds = new Set<string>([homepageKey]);
  for (const raw of sitemapUrls) {
    if (stats.discovered >= crawl.limits.maxPages) {
      stats.skipped += 1;
      continue;
    }
    const normalized = normalizePageUrl(raw, originUrl);
    if (!normalized || !allowedHosts.has(normalized.hostname) || seenSeeds.has(normalized.normalizedUrl)) continue;
    // Image/video sitemaps and sitemaps that list document downloads are
    // common -- same filter as link-following, applied to seeds too.
    if (isNonHtmlAssetUrl(normalized.url)) {
      seedAssetsSkipped += 1;
      continue;
    }
    seenSeeds.add(normalized.normalizedUrl);

    const added = await untilSetupDeadline(
      queue.addRequest({
        url: normalized.url,
        uniqueKey: normalized.normalizedUrl,
        userData: { depth: 1 },
      }),
    );
    if (!added.wasAlreadyPresent) stats.discovered += 1;
  }
  await flushStats(true);
  log(
    `[3/4] seeded ${stats.discovered} URL(s) into the queue` +
      (seedAssetsSkipped > 0 ? ` (${seedAssetsSkipped} asset URL(s) filtered out)` : ""),
  );

  // maxRequestsPerCrawl is scoped to this single crawler.run() call, not to
  // the crawl's lifetime -- budget only what's left of the page cap (stats
  // may already be non-zero if this crawl was recovered from a prior
  // attempt) so it still can't process more than crawl.limits.maxPages
  // pages in total.
  const remainingBudget = Math.max(0, crawl.limits.maxPages - stats.processed);
  if (remainingBudget === 0) {
    log(`[4/4] page budget already spent (${stats.processed}/${crawl.limits.maxPages}) -- nothing to crawl.`);
    await safeDrop(queue, tag);
    return;
  }

  log(`[4/4] crawling (concurrency ${MAX_CONCURRENCY}, budget ${remainingBudget} pages)...`);

  const crawler = new CheerioCrawler({
    requestQueue: queue,
    maxRequestsPerCrawl: remainingBudget,
    maxConcurrency: MAX_CONCURRENCY,
    sameDomainDelaySecs: SAME_DOMAIN_DELAY_SECS,
    requestHandlerTimeoutSecs: REQUEST_HANDLER_TIMEOUT_SECS,
    maxRequestRetries: MAX_REQUEST_RETRIES,

    async requestHandler({ request, response, body, $, crawler: self }) {
      // Checked here as well as in the poller so an in-flight request that
      // started before the cancel lands doesn't get recorded afterwards.
      if (cancelled) {
        self.autoscaledPool?.abort();
        return;
      }
      if (Date.now() > deadline) {
        log(`TIME LIMIT reached (${crawl.limits.timeLimitMinutes}min) -- stopping.`);
        self.autoscaledPool?.abort();
        return;
      }

      const depth = (request.userData?.depth as number | undefined) ?? 0;
      const finalUrl = request.loadedUrl ?? request.url;
      const redirectUrls = (response.redirectUrls ?? []).map((u: URL) => u.toString());
      const normalizedUrl = request.uniqueKey ?? request.url;

      // Extraction from the already-fetched HTML is essentially free -- no
      // extra request. Whether it's good enough or needs a browser re-render
      // is decided right after, and bounded so an all-SPA site can't turn a
      // fast discovery crawl into an expensive one (see MAX_PAGES_TO_RENDER).
      const xRobotsTag = headerValue(response.headers?.["x-robots-tag"]);
      const content = extractSeoContent($, { pageUrl: finalUrl, siteHosts: allowedHosts, xRobotsTag });
      if (needsBrowserRender(content) && flaggedForRender.length < MAX_PAGES_TO_RENDER) {
        flaggedForRender.push({ url: finalUrl, normalizedUrl });
      }

      await recordPage({
        url: request.url,
        normalizedUrl,
        httpStatus: response.statusCode ?? null,
        finalUrl: finalUrl !== request.url ? finalUrl : null,
        redirectChain: redirectUrls.length > 0 ? redirectUrls : null,
        depth,
        errorMessage: null,
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
        xRobotsTag,
        scripts: content.scripts,
        scriptCount: content.scriptCount,
        inlineScriptCount: content.inlineScriptCount,
        blockingScriptCount: content.blockingScriptCount,
        thirdPartyOrigins: content.thirdPartyOrigins,
        openGraph: content.openGraph,
        lang: content.lang,
        viewport: content.viewport,
        hreflang: content.hreflang,
        htmlBytes: typeof body === "string" ? Buffer.byteLength(body) : (body as Buffer | undefined)?.length ?? null,
        responseTimeMs: responseTotalMs(response),
        renderMethod: "http",
      });
      stats.processed += 1;
      lastProgressAt = Date.now();
      await flushStats();

      log(
        `  ${String(response.statusCode ?? "---")} d${depth} ` +
          `[${stats.processed}/${stats.discovered}] ${finalUrl}` +
          ` (${content.wordCount}w${content.title ? "" : ", NO TITLE"})`,
      );

      if (depth >= crawl.limits.maxDepth || stats.discovered >= crawl.limits.maxPages) {
        return;
      }

      // Reuses the links already parsed for storage above instead of walking
      // the DOM a second time: same result, one less pass per page. They are
      // absolute, deduplicated, and already restricted to allowedHosts.
      for (const link of content.internalLinks) {
        if (stats.discovered >= crawl.limits.maxPages) {
          stats.skipped += 1;
          continue;
        }

        const normalized = normalizePageUrl(link.url, finalUrl);
        if (!normalized) continue;
        // PDFs, images, archives etc. aren't crawlable pages. Skipped silently
        // rather than counted: they're neither an error nor a page we chose to
        // leave out of scope, so folding them into stats.skipped would make the
        // number meaningless on asset-heavy sites.
        if (isNonHtmlAssetUrl(normalized.url)) continue;

        if (!robots.isAllowed(normalized.url)) {
          stats.skipped += 1;
          continue;
        }

        const added = await queue.addRequest({
          url: normalized.url,
          uniqueKey: normalized.normalizedUrl,
          userData: { depth: depth + 1 },
        });
        if (!added.wasAlreadyPresent) stats.discovered += 1;
      }
    },

    // Runs before each retry. A non-HTML body will be non-HTML on every
    // attempt, so retrying only wastes requests against the target site.
    errorHandler({ request }, error) {
      if (isUnsupportedContentTypeError(error)) request.noRetry = true;
    },

    async failedRequestHandler({ request }, error) {
      // Not an error: the URL simply turned out to serve a PDF/image/etc.
      // with nothing in the path to reveal it up front. Recording a page row
      // would put a bogus "failed page" in the user's results.
      if (isUnsupportedContentTypeError(error)) {
        stats.skipped += 1;
        lastProgressAt = Date.now();
        await flushStats();
        log(`  SKIP (not a web page) ${request.url}`);
        return;
      }

      const depth = (request.userData?.depth as number | undefined) ?? 0;
      const message = String(error?.message ?? error);
      await recordPage({
        url: request.url,
        normalizedUrl: request.uniqueKey ?? request.url,
        httpStatus: null,
        finalUrl: null,
        redirectChain: null,
        depth,
        errorMessage: message.slice(0, 500),
      });
      stats.failed += 1;
      lastProgressAt = Date.now();
      await flushStats();
      log(`  FAIL d${depth} ${request.url} :: ${message.split("\n")[0].slice(0, 120)}`);
    },
  });

  const stallWatchdog = setInterval(() => {
    const idleMs = Date.now() - lastProgressAt;
    if (idleMs > STALL_TIMEOUT_MS) {
      stalled = true;
      console.error(
        `[crawl ${tag}] STALLED -- no progress for over ${STALL_TIMEOUT_MS / 60_000} min ` +
          `(processed ${stats.processed}/${stats.discovered}); aborting.`,
      );
      crawler.autoscaledPool?.abort();
      return;
    }
    // Heartbeat: proves the crawl is alive during quiet stretches (slow
    // pages, politeness delays) instead of looking hung.
    log(
      `... working: ${stats.processed}/${stats.discovered} processed, ` +
        `${stats.failed} failed, ${stats.skipped} skipped, idle ${(idleMs / 1000).toFixed(0)}s`,
    );
  }, STALL_CHECK_INTERVAL_MS);

  // Cooperative cancellation: the cancel endpoint writes status=CANCELLED
  // straight to the row, and this poll is what turns that into an actual
  // abort of the in-flight crawl.
  const cancelPoll = setInterval(() => {
    void db
      .select({ status: crawls.status })
      .from(crawls)
      .where(eq(crawls.id, crawl.id))
      .then(([row]) => {
        // A missing row means the whole website was deleted mid-crawl. Same
        // response as a cancel: stop now. Carrying on would just throw
        // foreign-key errors on every page write.
        if ((!row || row.status === "CANCELLED") && !cancelled) {
          cancelled = true;
          log(
            `${row ? "CANCELLED by user" : "CRAWL DELETED"} -- stopping ` +
              `(${stats.processed}/${stats.discovered} processed).`,
          );
          crawler.autoscaledPool?.abort();
        }
      })
      .catch(() => {
        // A transient DB blip must not kill a healthy crawl -- the next
        // tick retries, and the stall watchdog is still the backstop.
      });
  }, CANCEL_POLL_INTERVAL_MS);

  try {
    await crawler.run();
  } finally {
    clearInterval(stallWatchdog);
    clearInterval(cancelPoll);
  }

  await flushStats(true);

  if (cancelled) {
    // Queue dropped: this crawl is terminal (CANCELLED) and will never be
    // resumed, so leaving its on-disk queue behind would just leak storage.
    await safeDrop(queue, tag);
    throw new CrawlCancelledError(
      `Cancelled by user after ${stats.processed} page(s).`,
    );
  }

  if (stalled) {
    // Drop the queue -- the crawl is marked FAILED (not requeued), so this
    // exact crawl ID's queue will never be reopened again; a user-initiated
    // retry creates a fresh crawl with its own new queue.
    await safeDrop(queue, tag);
    throw new Error(
      `Crawl stalled: no progress for over ${STALL_TIMEOUT_MS / 60_000} minutes ` +
        `(processed ${stats.processed}/${stats.discovered} discovered).`,
    );
  }

  await safeDrop(queue, tag);
  log(
    `discovery done: ${stats.processed} processed, ${stats.failed} failed, ${stats.skipped} skipped, ` +
      `${flaggedForRender.length} flagged for browser render`,
  );

  // Stage 2: browser re-render for pages Stage 1 flagged as likely
  // unrendered JS shells. Isolated from Stage 1 -- a problem here can only
  // affect content accuracy for the flagged pages, never the discovery data
  // (URLs, status codes, redirects) already safely persisted above.
  if (flaggedForRender.length > 0) {
    if (Date.now() > deadline) {
      console.warn(
        `[crawl ${tag}] time limit reached before browser re-render stage -- ` +
          `${flaggedForRender.length} page(s) keep their HTTP-only content.`,
      );
    } else {
      log(`[render] launching browser for ${flaggedForRender.length} JS-heavy page(s)...`);
      const renderResult = await renderFlaggedPages(crawl.id, flaggedForRender, allowedHosts).catch((err) => {
        console.error(`[crawl ${tag}] browser re-render stage failed:`, err);
        return { rendered: 0, failed: flaggedForRender.length };
      });
      stats.rendered += renderResult.rendered;
      stats.failed += renderResult.failed;
      await flushStats(true);
      log(`[render] done: ${renderResult.rendered} rendered, ${renderResult.failed} failed`);
    }
  }

  log(
    `DONE ${website.domain} -- ${stats.processed} pages, ${stats.rendered} rendered, ` +
      `${stats.failed} failed, ${stats.skipped} skipped`,
  );
}
