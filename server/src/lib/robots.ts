import { RobotsTxtFile, Sitemap } from "@crawlee/utils";
import type { RobotsAudit, SitemapAudit } from "../db/schema.js";

const ROBOTS_TIMEOUT_MS = 8000;

export interface RobotsResult {
  rules: RobotsTxtFile;
  audit: RobotsAudit;
}

/**
 * Fetches robots.txt directly rather than via RobotsTxtFile.find().
 *
 * Crawlee's helper returns usable rules but hides the HTTP response, and we
 * need to report the real status code ("Found, 200" vs "Not found, 404") --
 * so this does the request itself and hands the body to RobotsTxtFile.from().
 * One request either way, and now the outcome is reportable.
 *
 * Any failure degrades to permissive "allow everything" rules: a missing or
 * broken robots.txt must never be the reason a crawl can't start.
 */
export async function loadRobotsRules(originUrl: string): Promise<RobotsResult> {
  const robotsUrl = new URL("/robots.txt", originUrl).toString();

  try {
    const response = await fetch(robotsUrl, {
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
      redirect: "follow",
    });
    const found = response.ok;
    const body = found ? await response.text() : "";
    const rules = RobotsTxtFile.from(robotsUrl, body);

    return {
      rules,
      audit: {
        found,
        status: response.status,
        url: robotsUrl,
        sizeBytes: found ? Buffer.byteLength(body) : 0,
        sitemapsDeclared: rules.getSitemaps(),
        // A robots.txt that disallows everything for us is worth surfacing
        // loudly -- it means the crawl legitimately found almost nothing.
        blocksEverything: found && !rules.isAllowed(originUrl),
        error: null,
      },
    };
  } catch (err) {
    return {
      rules: RobotsTxtFile.from(robotsUrl, ""),
      audit: {
        found: false,
        status: null,
        url: robotsUrl,
        sizeBytes: 0,
        sitemapsDeclared: [],
        blocksEverything: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export interface SitemapResult {
  urls: string[];
  audit: SitemapAudit;
}

/**
 * Discovers seed URLs from sitemaps: first the sitemap(s) declared in
 * robots.txt, falling back to the common locations. Best-effort -- returns
 * an empty list rather than throwing if nothing is reachable, and records
 * which route succeeded so the UI can explain where the sitemap came from.
 */
export async function discoverSitemapUrls(
  originUrl: string,
  robots: RobotsTxtFile,
): Promise<SitemapResult> {
  const declared = robots.getSitemaps();

  try {
    if (declared.length > 0) {
      const urls = await robots.parseUrlsFromSitemaps();
      return {
        urls,
        audit: { found: urls.length > 0, source: "robots", locations: declared, urlCount: urls.length, error: null },
      };
    }

    const sitemap = await Sitemap.tryCommonNames(originUrl);
    const locations = [new URL("/sitemap.xml", originUrl).toString()];
    return {
      urls: sitemap.urls,
      audit: {
        found: sitemap.urls.length > 0,
        source: sitemap.urls.length > 0 ? "common" : null,
        locations,
        urlCount: sitemap.urls.length,
        error: null,
      },
    };
  } catch (err) {
    return {
      urls: [],
      audit: {
        found: false,
        source: null,
        locations: declared,
        urlCount: 0,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
