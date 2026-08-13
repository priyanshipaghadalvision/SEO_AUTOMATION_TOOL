import { normalizePageUrl } from "../lib/url.js";

/**
 * The single join key between Search Console and our own crawl.
 *
 * Both sides must be reduced by the *same* function or the match silently
 * fails: Google reports "https://site.com/post/xyz/" while the crawler stores
 * "https://site.com/post/xyz". Reusing `normalizePageUrl` -- the exact
 * function that produced `pages.normalized_url` -- is what guarantees the two
 * sides agree, rather than two similar-looking implementations drifting apart.
 *
 * Returns null for anything unparseable. Callers must keep those rows and
 * surface them as explicitly unmatched: dropping one would display a page we
 * did crawl as "never crawled", which is worse than admitting we can't match it.
 */
export function toJoinKey(pageUrl: string): string | null {
  return normalizePageUrl(pageUrl, pageUrl)?.normalizedUrl ?? null;
}
