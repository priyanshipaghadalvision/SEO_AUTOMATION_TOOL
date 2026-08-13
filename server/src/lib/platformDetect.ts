export type Platform = "nextjs" | "wordpress" | "shopify" | "react" | "parked" | "custom" | "unknown";

export interface PlatformDetectionResult {
  platform: Platform;
  confidence: "high" | "medium" | "low";
  signals: string[];
}

const FETCH_TIMEOUT_MS = 8000;
// A parking-provider redirect stub is typically a few hundred bytes with no
// real content -- only worth following a JS redirect below this size, so we
// don't waste a second request chasing a redirect buried in a real app's bundle.
const REDIRECT_FOLLOW_MAX_HTML_LENGTH = 2000;

interface FetchedPage {
  html: string;
  headers: Headers;
}

async function fetchPage(url: string): Promise<FetchedPage | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "SEO-Automation-PlatformDetector/1.0" },
    });
    clearTimeout(timeout);
    return { html: await res.text(), headers: res.headers };
  } catch {
    return null;
  }
}

/** Extracts a same-page client-side redirect target, e.g. window.location.href = "/lander" */
function extractJsRedirectTarget(html: string): string | null {
  const match = html.match(
    /window\.location(?:\.href\s*=|\.replace\()\s*["']([^"']+)["']/i,
  );
  return match ? match[1] : null;
}

const PARKING_SIGNATURES: Array<{ name: string; test: (html: string, headers: Headers) => boolean }> = [
  {
    name: "godaddy_parking",
    test: (html, headers) =>
      headers.get("set-cookie")?.includes("lander_type=parkweb") === true ||
      html.includes("wsimg.com/parking-lander") ||
      html.includes("img1.wsimg.com"),
  },
  { name: "sedo_parking", test: (html) => html.includes("sedoparking.com") },
  { name: "bodis_parking", test: (html) => html.includes("bodis.com") },
  { name: "parkingcrew", test: (html) => html.includes("parkingcrew.net") },
  {
    name: "namecheap_parking",
    test: (html) => html.includes("parkingpage.namecheap.com") || html.includes("park.namecheap.com"),
  },
  { name: "dan_com_marketplace", test: (html) => html.includes("cdn.dan.com") || html.includes("dan.com/buy") },
  { name: "afternic", test: (html) => html.includes("afternic.com") },
  { name: "hugedomains", test: (html) => html.includes("hugedomains.com") },
  {
    name: "for_sale_phrase",
    test: (html) =>
      /this domain (is|may be) for sale/i.test(html) ||
      /buy this domain/i.test(html) ||
      /inquire about this domain/i.test(html),
  },
];

/**
 * Fetches the site's homepage and applies deterministic heuristics to
 * guess the platform. Best-effort: a failed fetch degrades to "unknown"
 * rather than blocking website creation. Follows one bounded client-side
 * redirect hop (common for domain-parking stubs) before giving up.
 */
export async function detectPlatform(originUrl: string): Promise<PlatformDetectionResult> {
  const initial = await fetchPage(originUrl);
  if (!initial) {
    return { platform: "unknown", confidence: "low", signals: ["fetch_failed"] };
  }

  let { html, headers } = initial;
  const followedRedirect: string[] = [];

  if (html.length > 0 && html.length <= REDIRECT_FOLLOW_MAX_HTML_LENGTH) {
    const target = extractJsRedirectTarget(html);
    if (target) {
      try {
        const resolved = new URL(target, originUrl).toString();
        const followed = await fetchPage(resolved);
        if (followed) {
          html = followed.html;
          headers = followed.headers;
          followedRedirect.push("followed_js_redirect");
        }
      } catch {
        // Unresolvable redirect target -- keep the original stub page.
      }
    }
  }

  const lowerHtml = html.toLowerCase();
  const poweredBy = headers.get("x-powered-by")?.toLowerCase() ?? "";

  // Parking/for-sale pages are checked first: their markup can otherwise
  // coincidentally trip a framework signature (e.g. a React-based lander).
  const parkingMatch = PARKING_SIGNATURES.find((sig) => sig.test(html, headers));
  if (parkingMatch) {
    return { platform: "parked", confidence: "high", signals: [...followedRedirect, parkingMatch.name] };
  }

  if (
    headers.has("x-shopify-stage") ||
    headers.has("x-shopid") ||
    lowerHtml.includes("cdn.shopify.com") ||
    lowerHtml.includes("shopify.com/s/files")
  ) {
    return { platform: "shopify", confidence: "high", signals: [...followedRedirect, "shopify_cdn_or_header"] };
  }

  if (
    lowerHtml.includes("wp-content") ||
    lowerHtml.includes("wp-includes") ||
    lowerHtml.includes('name="generator" content="wordpress')
  ) {
    return { platform: "wordpress", confidence: "high", signals: [...followedRedirect, "wordpress_markers"] };
  }

  if (
    lowerHtml.includes("__next_data__") ||
    lowerHtml.includes("/_next/static/") ||
    poweredBy.includes("next.js")
  ) {
    return { platform: "nextjs", confidence: "high", signals: [...followedRedirect, "nextjs_markers"] };
  }

  if (lowerHtml.includes('id="root"') || lowerHtml.includes("data-reactroot")) {
    return { platform: "react", confidence: "medium", signals: [...followedRedirect, "react_root_marker"] };
  }

  if (html) {
    return {
      platform: "custom",
      confidence: "low",
      signals: [...followedRedirect, "html_fetched_no_known_markers"],
    };
  }

  return { platform: "unknown", confidence: "low", signals: [...followedRedirect, "empty_response"] };
}
