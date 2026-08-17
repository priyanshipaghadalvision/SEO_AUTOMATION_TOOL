import { getAccessToken } from "./oauth.js";

/**
 * Thin client over the two Search Console endpoints this integration needs.
 *
 * Raw `fetch` rather than the `googleapis` package: two endpoints do not
 * justify a 30MB dependency, and going direct means retry and pagination
 * behave exactly as documented here rather than however the wrapper decides.
 */

const API_BASE = "https://searchconsole.googleapis.com/webmasters/v3";

/** The API's own per-request maximum. Fewer requests, same data. */
export const MAX_ROWS_PER_REQUEST = 25_000;

/** Retries for a 429 or 5xx. Google rate-limits per property, per minute. */
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1000;

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

/**
 * Whether a permission level actually allows reading Search Analytics.
 *
 * `sites.list` returns every property the account is associated with,
 * including ones it has never verified ownership of. Those come back as
 * `siteUnverifiedUser`, look completely normal in the list, and then fail
 * every data query with a 403. Checking the level up front is the difference
 * between refusing the link and letting someone wire up a property that can
 * never sync.
 */
export function canReadData(permissionLevel: string): boolean {
  return permissionLevel !== "siteUnverifiedUser";
}

export interface SearchAnalyticsRow {
  /** One entry per requested dimension, in the order they were requested. */
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export class GscApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GscApiError";
  }
}

export async function apiFetch<T>(userId: string, path: string, init?: RequestInit): Promise<T> {
  let lastError: GscApiError | null = null;
  // URL Inspection lives on a different base path (/v1) than Search
  // Analytics (/webmasters/v3), so absolute URLs pass through untouched.
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Fetched inside the loop so a token that expires mid-retry is renewed
    // rather than replayed.
    const token = await getAccessToken(userId);
    const res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    if (res.ok) return (await res.json()) as T;

    const body = await res.text().catch(() => "");
    const error = new GscApiError(res.status, describe(res.status, body));

    // 4xx other than 429 will fail identically however many times we ask.
    if (res.status !== 429 && res.status < 500) throw error;

    // A 429 is NOT retried. Google's quota is charged per call, so retrying a
    // daily-allowance rejection spends three more units of an allowance that
    // is already gone -- it cannot succeed, and it makes the next run start
    // further behind. The per-minute limit is also a 429, but the caller
    // throttles well below it, so treating every 429 as terminal costs
    // nothing and protects the quota.
    if (res.status === 429) throw error;

    lastError = error;
    if (attempt < MAX_ATTEMPTS) {
      const wait = retryAfterMs(res) ?? BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(wait);
    }
  }

  throw lastError ?? new GscApiError(500, "Search Console request failed.");
}

function describe(status: number, body: string): string {
  const detail = extractMessage(body);
  switch (status) {
    case 401:
      return "Google rejected the access token. Disconnect and reconnect Search Console.";
    case 403:
      // Overwhelmingly this is an unverified property rather than a missing
      // API or a wrong account, so lead with that.
      return (
        `Google denied access${detail ? `: ${detail}` : ""}. ` +
        "This usually means the connected account is listed on the property but never verified ownership of it — " +
        "verify it in Search Console, then sync again."
      );
    case 429:
      return "Search Console rate limit hit. Try a smaller date range or wait a minute.";
    default:
      return `Search Console returned ${status}${detail ? `: ${detail}` : ""}`;
  }
}

function extractMessage(body: string): string | null {
  try {
    return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? null;
  } catch {
    return null;
  }
}

/** Honours Google's own backoff hint when it sends one. */
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const URL_INSPECTION_ENDPOINT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

/** The slice of the inspection response this app stores. */
export interface IndexStatusResult {
  verdict?: string;
  coverageState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  pageFetchState?: string;
  googleCanonical?: string;
  userCanonical?: string;
  lastCrawlTime?: string;
  crawledAs?: string;
  sitemap?: string[];
  referringUrls?: string[];
}

export interface UrlInspectionResult {
  inspectionResultLink?: string;
  indexStatusResult?: IndexStatusResult;
  richResultsResult?: Record<string, unknown>;
  ampResult?: Record<string, unknown>;
  mobileUsabilityResult?: Record<string, unknown>;
}

/**
 * Asks Google what it knows about one URL: indexed or not, and why not.
 *
 * Quota is **2,000 URLs per property per day** and 600 per minute, which is
 * why callers batch and prioritise rather than sweeping a whole site. A 429
 * here usually means the daily allowance is spent, not that the request was
 * too fast -- retrying it harder does not help, so the caller stops instead.
 */
export async function inspectUrl(
  userId: string,
  siteUrl: string,
  inspectionUrl: string,
): Promise<UrlInspectionResult> {
  const json = await apiFetch<{ inspectionResult?: UrlInspectionResult }>(userId, URL_INSPECTION_ENDPOINT, {
    method: "POST",
    body: JSON.stringify({ inspectionUrl, siteUrl }),
  });
  return json.inspectionResult ?? {};
}

/** Every property the connected Google account can read. */
export async function listSites(userId: string): Promise<GscSite[]> {
  const json = await apiFetch<{ siteEntry?: GscSite[] }>(userId, "/sites");
  return json.siteEntry ?? [];
}

export interface SearchAnalyticsQuery {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions: string[];
  /** Google Search vertical. Image results are a separate data set from web. */
  searchType?: "web" | "image";
  /** Stop after this many rows overall, across pages. */
  maxRows?: number;
}

/**
 * Runs a Search Analytics query, following pagination until the API runs out
 * of rows or `maxRows` is reached.
 *
 * `dataState: "all"` includes Google's freshest available numbers. The
 * caller marks the newest two days provisional because Google may restate
 * them before they become final.
 */
export async function querySearchAnalytics(
  userId: string,
  query: SearchAnalyticsQuery,
): Promise<SearchAnalyticsRow[]> {
  const path = `/sites/${encodeURIComponent(query.siteUrl)}/searchAnalytics/query`;
  const limit = query.maxRows ?? Number.POSITIVE_INFINITY;
  const rows: SearchAnalyticsRow[] = [];
  let startRow = 0;

  while (rows.length < limit) {
    const rowLimit = Math.min(MAX_ROWS_PER_REQUEST, limit - rows.length);
    const page = await apiFetch<{ rows?: SearchAnalyticsRow[] }>(userId, path, {
      method: "POST",
      body: JSON.stringify({
        startDate: query.startDate,
        endDate: query.endDate,
        dimensions: query.dimensions,
        type: query.searchType ?? "web",
        dataState: "all",
        rowLimit,
        startRow,
      }),
    });

    const batch = page.rows ?? [];
    rows.push(...batch);
    // A short page is the API's way of saying there is nothing after it.
    if (batch.length < rowLimit) break;
    startRow += batch.length;
  }

  return rows;
}
