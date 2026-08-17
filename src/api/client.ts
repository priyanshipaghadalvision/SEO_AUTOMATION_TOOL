export interface Website {
  id: string;
  domain: string;
  originalUrl: string;
  platform: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface CrawlLimits {
  maxPages: number;
  maxDepth: number;
  timeLimitMinutes: number;
  allowedHosts: string[];
  seedUrls?: string[];
}

export interface CrawlStats {
  discovered: number;
  processed: number;
  failed: number;
  skipped: number;
  rendered: number;
}

export interface Crawl {
  id: string;
  websiteId: string;
  status: string;
  limits: CrawlLimits;
  stats: CrawlStats;
  siteAudit: SiteAudit | null;
  failureReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface Heading {
  level: number;
  text: string;
  selector?: string | null;
}

/** Where an element sits in the markup, for locating it in source. */
export interface ElementLocator {
  selector?: string | null;
  snippet?: string | null;
}

export interface PageImage extends ElementLocator {
  src: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  loading: string | null;
}

export type StructuredDataItem = Record<string, unknown>;

export interface PageLink extends ElementLocator {
  url: string;
  anchor: string | null;
  nofollow: boolean;
  count: number;
}

export interface HreflangEntry {
  lang: string;
  href: string;
}

export type SocialMeta = Record<string, string>;

export interface PageScript {
  src: string | null;
  async: boolean;
  defer: boolean;
  module: boolean;
  inlineBytes: number;
}

export interface RobotsAudit {
  found: boolean;
  status: number | null;
  url: string;
  sizeBytes: number;
  sitemapsDeclared: string[];
  blocksEverything: boolean;
  error: string | null;
}

export interface SitemapAudit {
  found: boolean;
  source: "robots" | "common" | null;
  locations: string[];
  urlCount: number;
  error: string | null;
}

export interface SiteAudit {
  robots: RobotsAudit;
  sitemap: SitemapAudit;
}

/**
 * What the paginated list endpoint returns: everything the table renders,
 * without the heavy per-page payloads (content text, link arrays, headings,
 * images, schema). Those come from `getPage` when a row is expanded.
 */
export interface PageSummary {
  id: string;
  crawlId: string;
  url: string;
  normalizedUrl: string;
  httpStatus: number | null;
  finalUrl: string | null;
  depth: number;
  errorMessage: string | null;
  title: string | null;
  wordCount: number | null;
  renderMethod: "http" | "browser" | null;
  contentHash: string | null;
  internalLinkCount: number | null;
  externalLinkCount: number | null;
  noindex: boolean | null;
  nofollow: boolean | null;
  loadTimeMs: number | null;
  responseTimeMs: number | null;
  htmlBytes: number | null;
  discoveredAt: string;
}

export interface Page {
  id: string;
  crawlId: string;
  url: string;
  normalizedUrl: string;
  httpStatus: number | null;
  finalUrl: string | null;
  redirectChain: string[] | null;
  depth: number;
  errorMessage: string | null;
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  robotsMeta: string | null;
  headings: Heading[] | null;
  images: PageImage[] | null;
  structuredData: StructuredDataItem[] | null;
  wordCount: number | null;
  loadTimeMs: number | null;
  renderMethod: "http" | "browser" | null;
  contentText: string | null;
  contentHash: string | null;
  internalLinks: PageLink[] | null;
  externalLinks: PageLink[] | null;
  internalLinkCount: number | null;
  externalLinkCount: number | null;
  noindex: boolean | null;
  nofollow: boolean | null;
  xRobotsTag: string | null;
  openGraph: SocialMeta | null;
  lang: string | null;
  viewport: string | null;
  hreflang: HreflangEntry[] | null;
  scripts: PageScript[] | null;
  scriptCount: number | null;
  inlineScriptCount: number | null;
  blockingScriptCount: number | null;
  thirdPartyOrigins: string[] | null;
  htmlBytes: number | null;
  responseTimeMs: number | null;
  discoveredAt: string;
}

const BASE_URL = import.meta.env.VITE_API_URL ?? "/api";

/** Thrown on a 401 so the UI can drop straight back to the login screen. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Your session has expired. Please sign in again.");
    this.name = "UnauthorizedError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    // Session lives in an httpOnly cookie, so it must be sent explicitly.
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const message = body?.message ?? body?.error ?? `Request failed with status ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
}

export function register(email: string, password: string, name?: string) {
  return request<{ user: User }>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  });
}

export function login(email: string, password: string) {
  return request<{ user: User }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function logout() {
  return request<{ ok: true }>("/auth/logout", { method: "POST" });
}

export function getMe() {
  return request<{ user: User }>("/auth/me");
}

export function listWebsites() {
  return request<{ websites: Website[] }>("/websites");
}

export function getWebsite(id: string) {
  return request<{ website: Website; crawls: Crawl[] }>(`/websites/${id}`);
}

export function createWebsite(url: string) {
  return request<{ website: Website; crawl: Crawl }>("/websites", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

export function queueCrawl(websiteId: string) {
  return request<{ crawl: Crawl }>(`/websites/${websiteId}/crawls`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function getCrawl(crawlId: string) {
  return request<{ crawl: Crawl }>(`/crawls/${crawlId}`);
}

export function cancelCrawl(crawlId: string) {
  return request<{ crawl: Crawl }>(`/crawls/${crawlId}/cancel`, { method: "POST" });
}

export function getCrawlPages(
  crawlId: string,
  opts?: { limit?: number; offset?: number; search?: string; noindex?: boolean },
) {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  if (opts?.search) params.set("search", opts.search);
  if (opts?.noindex) params.set("noindex", "true");
  const query = params.toString();
  return request<{
    pages: PageSummary[];
    /** Every page in the crawl. */
    total: number;
    /** Pages matching the search term -- what the pager walks. */
    matched: number;
    limit: number;
    offset: number;
  }>(`/crawls/${crawlId}/pages${query ? `?${query}` : ""}`);
}

export function getPage(crawlId: string, pageId: string) {
  return request<{ page: Page }>(`/crawls/${crawlId}/pages/${pageId}`);
}

export interface DuplicateGroup {
  hash: string;
  count: number;
  urls: string[];
}

export function getCrawlDuplicates(crawlId: string) {
  return request<{ duplicateGroups: DuplicateGroup[] }>(`/crawls/${crawlId}/duplicates`);
}

export type IssueSeverity = "critical" | "warning" | "notice";
export type IssueRisk = "low" | "medium" | "high";

export interface Issue {
  id: string;
  crawlId: string;
  pageId: string | null;
  type: string;
  severity: IssueSeverity;
  risk: IssueRisk;
  autoFixable: boolean;
  message: string;
  url: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface IssueTypeSummary {
  type: string;
  severity: IssueSeverity;
  risk: IssueRisk;
  autoFixable: boolean;
  count: number;
}

export interface IssuesResponse {
  issues: Issue[];
  bySeverity: Array<{ severity: IssueSeverity; count: number }>;
  byType: IssueTypeSummary[];
  /** Total matching the current filter, not just this page. */
  matched: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  truncated: boolean;
}

export function getCrawlIssues(
  crawlId: string,
  opts?: { severity?: string; type?: string; limit?: number; offset?: number },
) {
  const params = new URLSearchParams();
  if (opts?.severity) params.set("severity", opts.severity);
  if (opts?.type) params.set("type", opts.type);
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  const q = params.toString();
  return request<IssuesResponse>(`/crawls/${crawlId}/issues${q ? `?${q}` : ""}`);
}

export function analyzeCrawl(crawlId: string) {
  return request<{ issuesFound: number; bySeverity: Record<string, number> }>(`/crawls/${crawlId}/analyze`, {
    method: "POST",
  });
}

export type OptimizationAction =
  | "UPDATE_TITLE"
  | "UPDATE_DESCRIPTION"
  | "ADD_CANONICAL"
  | "ADD_H1"
  | "SET_IMAGE_ALT"
  | "ADD_SCHEMA"
  | "DEFER_SCRIPTS"
  | "FIX_REDIRECT_CHAIN"
  | "ADD_ROBOTS_TXT"
  | "ADD_SITEMAP";

export type OptimizationStatus = "pending" | "approved" | "rejected" | "applied";
export type OptimizationSource = "rule" | "ai";

export interface Optimization {
  id: string;
  crawlId: string;
  pageId: string | null;
  issueType: string;
  action: OptimizationAction;
  target: string | null;
  dedupeKey: string;
  oldValue: string | null;
  newValue: string;
  reason: string;
  /** 0-100. */
  confidence: number;
  risk: IssueRisk;
  status: OptimizationStatus;
  source: OptimizationSource;
  model: string | null;
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OptimizationsResponse {
  optimizations: Optimization[];
  byAction: Array<{ action: OptimizationAction; source: OptimizationSource; count: number }>;
  byStatus: Array<{ status: OptimizationStatus; count: number }>;
  /** Proposals matching the status filter -- what the pager walks. */
  matched: number;
  offset: number;
  limit: number;
}

export interface OptimizationRunResult {
  generated: number;
  bySource: { rule: number; ai: number };
  unhandledIssues: number;
  preservedReviews: number;
  aiEnabled: boolean;
  aiUnavailableReason: string | null;
  aiPagesSkipped: number;
  aiFailedPages: number;
  aiError: string | null;
}

export function getCrawlOptimizations(
  crawlId: string,
  opts?: { status?: OptimizationStatus; limit?: number; offset?: number },
) {
  const p = new URLSearchParams();
  if (opts?.status) p.set("status", opts.status);
  if (opts?.limit) p.set("limit", String(opts.limit));
  if (opts?.offset) p.set("offset", String(opts.offset));
  const q = p.toString();
  return request<OptimizationsResponse>(`/crawls/${crawlId}/optimizations${q ? `?${q}` : ""}`);
}

export function generateCrawlOptimizations(crawlId: string) {
  return request<OptimizationRunResult>(`/crawls/${crawlId}/optimize`, { method: "POST" });
}

export function setOptimizationStatus(crawlId: string, optimizationId: string, status: OptimizationStatus) {
  return request<{ optimization: Optimization }>(`/crawls/${crawlId}/optimizations/${optimizationId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

// ---------------------------------------------------------------------------
// Google Search Console
// ---------------------------------------------------------------------------

export interface GscConnection {
  id: string;
  googleEmail: string | null;
  scopes: string;
  createdAt: string;
}

export interface GscStatus {
  /** Whether the server has OAuth credentials at all. */
  configured: boolean;
  connected: boolean;
  connection: GscConnection | null;
  setupHint: string | null;
}

export interface GscProperty {
  siteUrl: string;
  permissionLevel: string;
  propertyType: "domain" | "url_prefix";
  /** False for `siteUnverifiedUser` — listed by Google but returns no data. */
  canReadData: boolean;
  linkedWebsiteId: string | null;
  /** Websites whose domain matches this property, so the picker can lead with them. */
  suggestedWebsiteIds: string[];
}

export interface GscSyncResult {
  siteUrl: string;
  startDate: string;
  endDate: string;
  rowsFetched: number;
  rowsWritten: number;
  pages: number;
  totalClicks: number;
  totalImpressions: number;
}

export interface GscPageMetric {
  pageUrl: string;
  clicks: number;
  impressions: number;
  /** 0..1. */
  ctr: number;
  position: number;
  days: number;
}

export function getGscStatus() {
  return request<GscStatus>("/gsc/status");
}

export function getGscAuthUrl() {
  return request<{ authUrl: string }>("/gsc/connect");
}

export function getGscProperties() {
  return request<{ properties: GscProperty[] }>("/gsc/properties");
}

export function linkGscProperty(websiteId: string, siteUrl: string) {
  return request<{ property: unknown }>("/gsc/link", {
    method: "POST",
    body: JSON.stringify({ websiteId, siteUrl }),
  });
}

export function unlinkGscProperty(websiteId: string) {
  return request<{ unlinked: true }>(`/gsc/link/${websiteId}`, { method: "DELETE" });
}

export function syncGscMetrics(websiteId: string) {
  return request<GscSyncResult>(`/gsc/sync/${websiteId}`, { method: "POST" });
}

/** One row of a non-page breakdown: a query, a device, or a country. */
export interface GscBreakdownRow {
  dimension: "query" | "device" | "country" | "searchAppearance";
  keyValue: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  pages: number;
  firstDate: string | null;
  lastDate: string | null;
}

export type GscVerdict = "PASS" | "PARTIAL" | "FAIL" | "NEUTRAL" | "VERDICT_UNSPECIFIED";

export interface GscInspectionRaw {
  inspectionResultLink?: string | null;
  referringUrls?: string[];
  richResults?: Record<string, unknown> | null;
  amp?: Record<string, unknown> | null;
  mobileUsability?: Record<string, unknown> | null;
}

export interface GscInspection {
  pageUrl: string;
  verdict: GscVerdict;
  /** Google's own reason, e.g. "Crawled - currently not indexed". */
  coverageState: string | null;
  robotsTxtState: string | null;
  indexingState: string | null;
  pageFetchState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlTime: string | null;
  crawledAs: string | null;
  sitemaps: string[] | null;
  raw: GscInspectionRaw | null;
  inspectedAt: string;
}

export interface GscInspectionRunResult {
  inspected: number;
  failed: number;
  remaining: number;
  quotaUsedToday: number;
  quotaRemainingToday: number;
  stoppedReason: string | null;
  /** Google refused on quota though our meter had budget -- trust Google. */
  quotaDisagreement: boolean;
  byVerdict: Record<string, number>;
}

export function inspectGscUrls(websiteId: string, batchSize?: number) {
  return request<GscInspectionRunResult>(`/gsc/inspect/${websiteId}`, {
    method: "POST",
    body: JSON.stringify(batchSize ? { batchSize } : {}),
  });
}

export function crawlGscReason(websiteId: string, reason: string, pageUrls: string[]) {
  return request<{ crawl: Crawl; urlsQueued: number }>(`/gsc/crawl-reason/${websiteId}`, {
    method: "POST",
    body: JSON.stringify({ reason, pageUrls }),
  });
}

export interface GscDateRange {
  startDate: string;
  endDate: string;
  /** Newest day Google has settled data for (~3 days behind today). */
  latestAvailable: string;
  /** Data on and after this date is fresh and can still be restated by Google. */
  provisionalStart: string;
  /** Set when the requested range was narrowed, with the reason. */
  clampedReason: string | null;
}

export interface GscMetricsResponse {
  property: { siteUrl: string; propertyType: string; lastSyncedAt: string | null };
  range: GscDateRange;
  searchType: "web" | "image";
  /** True when this range wasn't stored and had to be pulled from Google. */
  fetchedLive: boolean;
  /** True when a live fetch failed and stored data is being shown instead. */
  partial: boolean;
  totals: GscTotals | null;
  trend: Array<{ date: string; clicks: number; impressions: number }>;
  pages: GscPageMetric[];
  queries: GscBreakdownRow[];
  devices: GscBreakdownRow[];
  countries: GscBreakdownRow[];
  searchAppearances: GscBreakdownRow[];
  inspections: GscInspection[];
  /** Server-side rollup, correct even when the row list above is truncated. */
  coverage: Array<{ verdict: GscVerdict; coverageState: string | null; count: number }>;
}

export function getGscMetrics(websiteId: string, range?: { start: string; end: string }, searchType: "web" | "image" = "web") {
  const p = new URLSearchParams({ type: searchType });
  if (range) { p.set("start", range.start); p.set("end", range.end); }
  const q = `?${p.toString()}`;
  return request<GscMetricsResponse>(`/gsc/metrics/${websiteId}${q}`);
}

export type UrlBucket =
  | "not_indexed"
  | "not_crawled"
  | "indexed_traffic"
  | "indexed_no_clicks"
  | "crawled_no_data";

/** One URL, with everything the crawl and Search Console each know about it. */
export interface MergedUrlRow {
  url: string;
  bucket: UrlBucket;
  httpStatus: number | null;
  title: string | null;
  wordCount: number | null;
  inboundLinkCount: number | null;
  noindex: boolean | null;
  issueCount: number;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
  verdict: string | null;
  coverageState: string | null;
}

export interface MergedUrlsResponse {
  rows: MergedUrlRow[];
  counts: Record<UrlBucket, number>;
  /** Every URL in the view, ignoring the active filter. */
  total: number;
  /** URLs matching the bucket/search filter -- what the pager walks. */
  matched: number;
  offset: number;
  limit: number;
  /** Which crawl supplied the crawl-side columns. */
  crawlId: string | null;
  range: GscDateRange;
  gscLinked: boolean;
  siteUrl: string | null;
}

export function getMergedUrls(
  websiteId: string,
  opts?: {
    start?: string;
    end?: string;
    bucket?: UrlBucket;
    search?: string;
    limit?: number;
    offset?: number;
  },
) {
  const p = new URLSearchParams();
  if (opts?.start) p.set("start", opts.start);
  if (opts?.end) p.set("end", opts.end);
  if (opts?.bucket) p.set("bucket", opts.bucket);
  if (opts?.search) p.set("search", opts.search);
  if (opts?.limit) p.set("limit", String(opts.limit));
  if (opts?.offset) p.set("offset", String(opts.offset));
  const q = p.toString();
  return request<MergedUrlsResponse>(`/gsc/urls/${websiteId}${q ? `?${q}` : ""}`);
}

export function disconnectGsc() {
  return request<{ disconnected: true }>("/gsc/connection", { method: "DELETE" });
}

export function deleteWebsite(websiteId: string) {
  return request<{ deleted: true; domain: string; deletedCrawls: number }>(`/websites/${websiteId}`, {
    method: "DELETE",
  });
}

export function redetectPlatform(websiteId: string) {
  return request<{ website: Website }>(`/websites/${websiteId}/redetect-platform`, {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// GSC data integrations: sitemaps, web vitals, links, enhancements, mobile,
// security
// ---------------------------------------------------------------------------

export interface SitemapRow {
  path: string;
  lastSubmitted: string | null;
  lastDownloaded: string | null;
  isPending: boolean;
  isSitemapsIndex: boolean;
  warnings: number;
  errors: number;
  contents: Array<{ type: string; submitted: number; indexed: number }>;
}

export interface GscSitemapsResponse {
  gscLinked: boolean;
  sitemaps: SitemapRow[];
  fetchedAt: string | null;
}

export interface SitemapSyncResult {
  synced: number;
  sitemaps: SitemapRow[];
}

/** One URL's Core Web Vitals from PageSpeed Insights (CrUX field data or Lighthouse lab fallback). */
export interface CwvRow {
  url: string;
  strategy: string;
  source: "field" | "lab" | "none";
  /** Lighthouse 0-100, null when absent. */
  performanceScore: number | null;
  lcpMs: number | null;
  inpMs: number | null;
  cls: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
  /** Per-metric category, e.g. { LCP: "FAST" }. */
  categories: Record<string, string>;
  overall: string | null;
  collectedAt: string;
}

export interface WebVitalsResponse {
  rows: CwvRow[];
  collectedAt: string | null;
}

export interface WebVitalsRunResult {
  tested: number;
  failed: number;
  /** Set when the run halted early, e.g. PSI quota exhausted. */
  stoppedReason: string | null;
  rows: CwvRow[];
}

export interface LinkPageRow {
  url: string;
  title: string | null;
  inboundLinks: number;
  depth: number | null;
}

export interface LinkDomainRow {
  domain: string;
  links: number;
  sourcePages: number;
}

export interface OrphanRow {
  url: string;
  title: string | null;
  depth: number | null;
}

export interface SiteLinksResponse {
  view: string;
  /** Rows matching the view -- what the pager walks. */
  total: number;
  offset: number;
  limit: number;
  /** Shape depends on `view`: pages -> LinkPageRow, domains -> LinkDomainRow, orphans -> OrphanRow. */
  rows: Array<LinkPageRow | LinkDomainRow | OrphanRow>;
}

export interface EnhancementTypeRow {
  /** schema.org `@type` from parsed JSON-LD. */
  type: string;
  pages: number;
  items: number;
  /** At most 3. */
  sampleUrls: string[];
}

export interface EnhancementsResponse {
  totalPages: number;
  pagesWithData: number;
  pagesWithNone: number;
  types: EnhancementTypeRow[];
}

export interface MobileUsabilityResponse {
  totalPages: number;
  withViewport: number;
  missingViewport: number;
  /** Capped at 100 rows server-side. */
  missingViewportRows: Array<{ url: string; title: string | null }>;
  /** Mobile-strategy vitals for the same site. */
  cwv: CwvRow[];
}

/** From Safe Browsing match.threatType + match.threat.url. */
export interface ThreatRow {
  threatType: string;
  url: string;
}

export interface SecurityStatusResponse {
  /** "unavailable" when the server has no GOOGLE_API_KEY for Safe Browsing. */
  status: "clean" | "flagged" | "unavailable";
  threats: ThreatRow[];
  checkedAt: string | null;
  /** Deep links into the GSC UI -- manual actions have no API. */
  gscLinks: { manualActions: string; securityIssues: string };
}

export function getGscSitemaps(websiteId: string) {
  return request<GscSitemapsResponse>(`/gsc/sitemaps/${websiteId}`);
}

export function syncGscSitemaps(websiteId: string) {
  return request<SitemapSyncResult>(`/gsc/sitemaps/${websiteId}/sync`, { method: "POST" });
}

export function getWebVitals(websiteId: string, strategy = "mobile") {
  return request<WebVitalsResponse>(`/gsc/cwv/${websiteId}?strategy=${strategy}`);
}

export function runWebVitals(websiteId: string, opts?: { limit?: number; strategy?: string }) {
  return request<WebVitalsRunResult>(`/gsc/cwv/${websiteId}/run`, {
    method: "POST",
    body: JSON.stringify(opts ?? {}),
  });
}

export function getSiteLinks(
  websiteId: string,
  opts: { view: "pages" | "domains" | "orphans"; limit?: number; offset?: number },
) {
  const p = new URLSearchParams();
  p.set("view", opts.view);
  if (opts.limit) p.set("limit", String(opts.limit));
  if (opts.offset) p.set("offset", String(opts.offset));
  return request<SiteLinksResponse>(`/gsc/links/${websiteId}?${p.toString()}`);
}

export function getGscEnhancements(websiteId: string) {
  return request<EnhancementsResponse>(`/gsc/enhancements/${websiteId}`);
}

export function getMobileUsability(websiteId: string) {
  return request<MobileUsabilityResponse>(`/gsc/mobile/${websiteId}`);
}

export function getSecurityStatus(websiteId: string) {
  return request<SecurityStatusResponse>(`/gsc/security/${websiteId}`);
}

export function runSecurityCheck(websiteId: string) {
  return request<SecurityStatusResponse>(`/gsc/security/${websiteId}/check`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Index coverage: why pages aren't indexed
// ---------------------------------------------------------------------------

/** One row of the coverage table, mirroring Search Console's Reason / Source / Pages. */
export interface CoverageReasonRow {
  reason: string;
  /** "Website" reasons come from our crawl; "Google systems" need URL Inspection. */
  source: "Website" | "Google systems";
  pages: number;
  /** False when the data behind the reason hasn't been collected -- 0 means unknown, not clean. */
  available: boolean;
  /** At most 5. */
  sampleUrls: string[];
  /** One plain sentence: what the reason means and what to do about it. */
  detail: string;
}

export interface CoverageResponse {
  crawlId: string | null;
  crawledAt: string | null;
  totalCrawled: number;
  indexableCount: number;
  /** The seven Website-source reasons, pages desc. Zero-count rows are included. */
  reasons: CoverageReasonRow[];
  /** The three Google-systems reasons; `available: false` until URLs are inspected. */
  googleReasons: CoverageReasonRow[];
  /** Stored inspection rows for the linked property. */
  inspectionsAvailable: number;
}

export function getCoverage(websiteId: string) {
  return request<CoverageResponse>(`/gsc/coverage/${websiteId}`);
}
