import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  date,
  timestamp,
  jsonb,
  boolean,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const websiteStatusEnum = pgEnum("website_status", ["active", "archived"]);

export const crawlStatusEnum = pgEnum("crawl_status", [
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export const platformEnum = pgEnum("platform_type", [
  "nextjs",
  "wordpress",
  "shopify",
  "react",
  "parked",
  "custom",
  "unknown",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Stored lowercased so lookups are case-insensitive without a functional index.
    email: text("email").notNull().unique(),
    name: text("name"),
    // scrypt digest in "salt:hash" form -- never the password itself.
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("users_email_idx").on(table.email)],
);

export const websites = pgTable(
  "websites",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Owner. Every read and write is scoped to this so one user can never
    // see or touch another's sites -- and crawls/pages inherit the same
    // isolation through their website_id chain.
    //
    // Nullable ONLY so the migration can land on a database that already has
    // rows; a NULL owner is unreachable through the API (every query filters
    // on a real user id), so pre-auth data is invisible rather than leaked.
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    domain: text("domain").notNull().unique(),
    originalUrl: text("original_url").notNull(),
    platform: platformEnum("platform").notNull().default("unknown"),
    status: websiteStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("websites_domain_idx").on(table.domain),
    index("websites_user_id_idx").on(table.userId),
  ],
);

export type CrawlLimits = {
  maxPages: number;
  maxDepth: number;
  timeLimitMinutes: number;
  allowedHosts: string[];
  /** Present only for a targeted crawl; skips homepage and sitemap seeding. */
  seedUrls?: string[];
};

export type CrawlStats = {
  discovered: number;
  processed: number;
  failed: number;
  skipped: number;
  rendered: number;
};

export const DEFAULT_CRAWL_STATS: CrawlStats = {
  discovered: 0,
  processed: 0,
  failed: 0,
  skipped: 0,
  rendered: 0,
};

export type RobotsAudit = {
  found: boolean;
  status: number | null;
  url: string;
  sizeBytes: number;
  sitemapsDeclared: string[];
  blocksEverything: boolean;
  error: string | null;
};

export type SitemapAudit = {
  found: boolean;
  /** "robots" = declared in robots.txt, "common" = found at /sitemap.xml. */
  source: "robots" | "common" | null;
  locations: string[];
  urlCount: number;
  error: string | null;
};

/** Site-wide checks that belong to the crawl as a whole, not any one page. */
export type SiteAudit = {
  robots: RobotsAudit;
  sitemap: SitemapAudit;
};

export const crawls = pgTable(
  "crawls",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    websiteId: uuid("website_id")
      .notNull()
      .references(() => websites.id, { onDelete: "cascade" }),
    status: crawlStatusEnum("status").notNull().default("QUEUED"),
    limits: jsonb("limits").$type<CrawlLimits>().notNull(),
    stats: jsonb("stats").$type<CrawlStats>().notNull().default(DEFAULT_CRAWL_STATS),
    // Written once during crawl setup; null until the setup phase completes.
    siteAudit: jsonb("site_audit").$type<SiteAudit>(),
    failureReason: text("failure_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("crawls_website_id_idx").on(table.websiteId)],
);

export const renderMethodEnum = pgEnum("render_method", ["http", "browser"]);

/**
 * Locators attached to every extracted element so a finding can point a
 * developer at the exact spot in the markup instead of just naming the page.
 *
 * `selector` is a CSS path for locating the node in a live DOM; `snippet` is
 * the element's opening tag (attributes included), which is what someone
 * actually greps for in source. Both are capped -- see extractSeoContent.
 */
export type ElementLocator = {
  selector: string | null;
  snippet: string | null;
};

export type Heading = { level: number; text: string; selector?: string | null };
export type PageImage = {
  src: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  loading: string | null;
} & Partial<ElementLocator>;
export type StructuredDataItem = Record<string, unknown>;
export type PageLink = {
  url: string;
  anchor: string | null;
  nofollow: boolean;
  /** How many times this same target is linked from the page. */
  count: number;
} & Partial<ElementLocator>;
export type HreflangEntry = { lang: string; href: string };
export type PageScript = {
  /** null for an inline <script> block. */
  src: string | null;
  async: boolean;
  defer: boolean;
  module: boolean;
  /** Bytes of inline script source; 0 for external files. */
  inlineBytes: number;
};
/** og:*, twitter:*, and article:* meta tags, keyed by their full property name. */
export type SocialMeta = Record<string, string>;

export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    httpStatus: integer("http_status"),
    finalUrl: text("final_url"),
    // Ordered list of intermediate URLs actually visited before the final response.
    // Per-hop status codes aren't reliably available from the underlying HTTP client.
    redirectChain: jsonb("redirect_chain").$type<string[]>(),
    depth: integer("depth").notNull().default(0),
    errorMessage: text("error_message"),

    // SEO content -- extracted from the raw HTTP response first (cheap); if that
    // looks like an unrendered JS shell, re-extracted from a real rendered
    // browser DOM instead. renderMethod records which one actually produced
    // the stored values, so results stay explainable.
    title: text("title"),
    metaDescription: text("meta_description"),
    canonicalUrl: text("canonical_url"),
    robotsMeta: text("robots_meta"),
    headings: jsonb("headings").$type<Heading[]>(),
    images: jsonb("images").$type<PageImage[]>(),
    structuredData: jsonb("structured_data").$type<StructuredDataItem[]>(),
    wordCount: integer("word_count"),
    loadTimeMs: integer("load_time_ms"),
    renderMethod: renderMethodEnum("render_method"),

    // Full visible text, truncated (see MAX_CONTENT_CHARS). Needed so later
    // AI/content-gap stages don't have to re-crawl every page.
    contentText: text("content_text"),
    // SHA-256 of the *untruncated*, whitespace-normalised, lowercased text.
    // Two pages sharing a hash are exact duplicates; indexed below so that
    // check is a cheap GROUP BY instead of an N^2 comparison.
    contentHash: text("content_hash"),

    // Link graph. Stored per-page rather than derived at crawl time so
    // orphan detection, internal-link opportunities and link-equity analysis
    // can all run later without another crawl.
    internalLinks: jsonb("internal_links").$type<PageLink[]>(),
    externalLinks: jsonb("external_links").$type<PageLink[]>(),
    // True totals before the storage caps are applied, so a page with 5000
    // links still reports 5000 even though only the first N are kept.
    internalLinkCount: integer("internal_link_count"),
    externalLinkCount: integer("external_link_count"),

    // Resolved from BOTH the robots meta tag and the X-Robots-Tag response
    // header -- either alone is an incomplete picture of indexability.
    noindex: boolean("noindex"),
    nofollow: boolean("nofollow"),
    xRobotsTag: text("x_robots_tag"),

    openGraph: jsonb("open_graph").$type<SocialMeta>(),
    lang: text("lang"),
    viewport: text("viewport"),
    hreflang: jsonb("hreflang").$type<HreflangEntry[]>(),

    // JavaScript profile: what the page loads, how it's loaded, and which
    // third-party origins it pulls in. Render-blocking scripts (neither
    // async nor defer) and heavy third-party counts are both real SEO/perf
    // signals, and the API/script origins matter for the JS-rendering story.
    scripts: jsonb("scripts").$type<PageScript[]>(),
    scriptCount: integer("script_count"),
    inlineScriptCount: integer("inline_script_count"),
    blockingScriptCount: integer("blocking_script_count"),
    thirdPartyOrigins: jsonb("third_party_origins").$type<string[]>(),

    // How many OTHER crawled pages link to this one. Computed after the
    // crawl finishes (a page's inbound links aren't knowable until every
    // page has been seen) and is what makes orphan / weakly-linked
    // detection possible without a separate edge table.
    inboundLinkCount: integer("inbound_link_count"),

    // Page-weight and timing of the HTTP fetch itself (loadTimeMs above is
    // the browser-render time, only set for Stage 2 pages).
    htmlBytes: integer("html_bytes"),
    responseTimeMs: integer("response_time_ms"),

    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pages_crawl_id_idx").on(table.crawlId),
    // NOTE: a (crawl_id, discovered_at DESC) index was tried here and removed.
    // EXPLAIN showed the planner ignoring it -- at ~1,100 rows per crawl a
    // top-N heapsort over the crawl_id index wins, and the list query already
    // runs in 4.7ms. Keeping it would have added write cost to every page
    // INSERT during a crawl, which is precisely the load being reduced.
    // Revisit only if the page list is measured slow on a much larger crawl.
    uniqueIndex("pages_crawl_normalized_url_idx").on(table.crawlId, table.normalizedUrl),
    index("pages_content_hash_idx").on(table.crawlId, table.contentHash),
  ],
);

export const issueSeverityEnum = pgEnum("issue_severity", ["critical", "warning", "notice"]);

/**
 * How safely an issue could be fixed without a human, per §14's risk tiers.
 * Stored on the issue (not derived in the UI) so the future automation
 * engine has a single authoritative source for what it may touch.
 */
export const issueRiskEnum = pgEnum("issue_risk", ["low", "medium", "high"]);

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    // Null for site-wide findings (missing sitemap, www/non-www conflicts)
    // that belong to no single page.
    pageId: uuid("page_id").references(() => pages.id, { onDelete: "cascade" }),
    /** Stable machine key, e.g. "title.missing" -- safe to match on in code. */
    type: text("type").notNull(),
    severity: issueSeverityEnum("severity").notNull(),
    risk: issueRiskEnum("risk").notNull(),
    /** True if a fix can be generated mechanically with no judgement call. */
    autoFixable: boolean("auto_fixable").notNull().default(false),
    /** Human-readable one-liner shown in the UI. */
    message: text("message").notNull(),
    /** The page URL, denormalised so listing issues needs no join. */
    url: text("url"),
    /** Rule-specific evidence (counts, offending values, related URLs). */
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("issues_crawl_id_idx").on(table.crawlId),
    index("issues_crawl_type_idx").on(table.crawlId, table.type),
    index("issues_crawl_severity_idx").on(table.crawlId, table.severity),
    // Measured need, not a guess: counting issues per page in the merged URL
    // view ran 12,807 lookups against 93,354 rows and hit the 60s statement
    // timeout without this.
    index("issues_page_id_idx").on(table.pageId),
  ],
);

/**
 * What kind of change an optimization proposes. Kept as a Postgres enum so a
 * typo in a provider can never write a value the UI doesn't know how to
 * render, and so adding an action is a deliberate, migrated decision.
 */
export const optimizationActionEnum = pgEnum("optimization_action", [
  "UPDATE_TITLE",
  "UPDATE_DESCRIPTION",
  "ADD_CANONICAL",
  "ADD_H1",
  "SET_IMAGE_ALT",
  "ADD_SCHEMA",
  "DEFER_SCRIPTS",
  "FIX_REDIRECT_CHAIN",
  "ADD_ROBOTS_TXT",
  "ADD_SITEMAP",
]);

/**
 * Review state. Nothing is ever applied to a live site automatically -- a
 * proposal starts `pending` and only a human moves it on, which is what keeps
 * a medium/high-risk rewrite from shipping on a model's say-so.
 */
export const optimizationStatusEnum = pgEnum("optimization_status", [
  "pending",
  "approved",
  "rejected",
  "applied",
]);

/** Which engine produced the proposal: deterministic rules, or an LLM. */
export const optimizationSourceEnum = pgEnum("optimization_source", ["rule", "ai"]);

export const optimizations = pgTable(
  "optimizations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    crawlId: uuid("crawl_id")
      .notNull()
      .references(() => crawls.id, { onDelete: "cascade" }),
    // Null for site-wide proposals (robots.txt, sitemap).
    pageId: uuid("page_id").references(() => pages.id, { onDelete: "cascade" }),

    /**
     * The issue type this answers, e.g. "title.too_long".
     *
     * Deliberately NOT a foreign key to `issues`: re-analysis deletes and
     * recreates every issue row, so an FK with ON DELETE CASCADE would throw
     * away a user's approved fixes every time they hit "Re-analyse". Keying
     * on the stable type + page instead makes proposals survive re-analysis.
     */
    issueType: text("issue_type").notNull(),
    action: optimizationActionEnum("action").notNull(),

    /**
     * Which sub-element the change applies to, when a page has many of them
     * (an image `src`, a script URL). Null when the action targets the page
     * as a whole.
     */
    target: text("target"),

    /**
     * Stable identity for one proposal: `${pageId|site}|${issueType}|${action}|${target}`.
     *
     * Regenerating is an upsert on this, so running the engine twice updates
     * proposals in place rather than stacking near-identical rows -- and the
     * user's review status survives a regeneration.
     */
    dedupeKey: text("dedupe_key").notNull(),

    /** Current value being replaced; null when the fix is purely additive. */
    oldValue: text("old_value"),
    /** The proposed replacement, ready to paste. */
    newValue: text("new_value").notNull(),
    /** Why this change helps, in one or two sentences. */
    reason: text("reason").notNull(),
    /**
     * 0-100. Rule-derived values are honest about being mechanical -- a title
     * truncated at a word boundary scores well below one an LLM rewrote with
     * the page content in view. Stored as an int percent so sorting and
     * threshold filters stay exact.
     */
    confidence: integer("confidence_pct").notNull(),
    risk: issueRiskEnum("risk").notNull(),
    status: optimizationStatusEnum("status").notNull().default("pending"),
    source: optimizationSourceEnum("source").notNull(),
    /** Model id for `ai` proposals; null for `rule`. */
    model: text("model"),
    /** The page URL, denormalised so listing needs no join. */
    url: text("url"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("optimizations_crawl_id_idx").on(table.crawlId),
    index("optimizations_crawl_status_idx").on(table.crawlId, table.status),
    uniqueIndex("optimizations_dedupe_idx").on(table.crawlId, table.dedupeKey),
  ],
);

/**
 * Search Console exposes two kinds of property, and they are not
 * interchangeable: a domain property covers every subdomain and protocol and
 * is addressed as `sc-domain:example.com`, while a URL-prefix property covers
 * exactly one origin and path and is addressed as `https://example.com/`.
 * The API takes whichever string the property was registered under, so the
 * distinction has to survive into storage rather than being re-derived.
 */
export const gscPropertyTypeEnum = pgEnum("gsc_property_type", ["domain", "url_prefix"]);

export const gscConnections = pgTable(
  "gsc_connections",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // One Google account per user. Reconnecting replaces the row rather than
    // accumulating stale grants.
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Which Google account granted access, shown in the UI so it's obvious. */
    googleEmail: text("google_email"),

    /**
     * AES-256-GCM ciphertext, never the raw token.
     *
     * A Search Console refresh token is a long-lived bearer credential to
     * someone's Google data: a database dump that leaked these in plaintext
     * would hand over every connected account. It is also never returned by
     * any endpoint -- see the GSC routes, which select explicit columns.
     */
    refreshTokenEnc: text("refresh_token_enc").notNull(),
    /** Short-lived; cached only to avoid a refresh round-trip on every call. */
    accessToken: text("access_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    /** Scopes Google actually granted, which can be narrower than requested. */
    scopes: text("scopes").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("gsc_connections_user_id_idx").on(table.userId)],
);

export const gscProperties = pgTable(
  "gsc_properties",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // One GSC property per website: the link is what lets a crawl's issues be
    // ranked by the traffic the same URLs actually receive.
    websiteId: uuid("website_id")
      .notNull()
      .unique()
      .references(() => websites.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => gscConnections.id, { onDelete: "cascade" }),
    /** The property string exactly as Search Console reports it. */
    siteUrl: text("site_url").notNull(),
    propertyType: gscPropertyTypeEnum("property_type").notNull(),
    /** siteFullUser / siteOwner / siteRestrictedUser, straight from the API. */
    permissionLevel: text("permission_level"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("gsc_properties_connection_idx").on(table.connectionId)],
);

/** Search verticals supported by the Search Analytics API. */
export const gscSearchTypeEnum = pgEnum("gsc_search_type", ["web", "image"]);

export const gscPageMetrics = pgTable(
  "gsc_page_metrics",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => gscProperties.id, { onDelete: "cascade" }),
    /** The page URL as Google reports it, not as we crawled it. */
    pageUrl: text("page_url").notNull(),
    /**
     * The same URL run through the crawler's own normalizer.
     *
     * The join key between Search Console and our crawl. Google reports
     * "/post/xyz/" while `pages.normalized_url` holds "/post/xyz", so matching
     * on the raw URL silently misses -- and a miss here shows a crawled page
     * as "never crawled", which is the worst kind of wrong for a diagnostic.
     * Nullable because a URL Google reports may not parse.
     */
    normalizedUrl: text("normalized_url"),
    /** Date-only (YYYY-MM-DD); Search Console reports per calendar day. */
    date: date("date").notNull(),
    /** Search vertical reported by Search Analytics; never mix web and image totals. */
    searchType: gscSearchTypeEnum("search_type").notNull().default("web"),

    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    /** 0..1. Google's own figure rather than clicks/impressions rounded. */
    ctr: real("ctr").notNull(),
    /** Average position, e.g. 8.34. Lower is better. */
    position: real("position").notNull(),

    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Search Console restates recent days as data finalises, so a re-sync of
    // an overlapping window must update rather than duplicate.
    uniqueIndex("gsc_page_metrics_unique_idx").on(table.propertyId, table.pageUrl, table.date, table.searchType),
    index("gsc_page_metrics_property_date_idx").on(table.propertyId, table.searchType, table.date),
    index("gsc_page_metrics_url_idx").on(table.propertyId, table.pageUrl),
    index("gsc_page_metrics_normalized_idx").on(table.propertyId, table.normalizedUrl),
  ],
);

/** Non-page dimensions Search Analytics can slice by. */
export const gscDimensionEnum = pgEnum("gsc_dimension", ["query", "device", "country", "searchAppearance"]);

/**
 * Window-aggregated slices: top queries, device split, country split.
 *
 * Stored per window rather than per day, unlike `gscPageMetrics`. Query data
 * is the reason: a site with 10,000 distinct queries over 28 days would be
 * 280,000 daily rows for a table whose only real use is "what are people
 * searching to find us" -- a question the aggregate answers exactly as well
 * for a fraction of the storage and API cost. Day-level trend still comes
 * from the page table, which does keep daily granularity.
 */
export const gscBreakdowns = pgTable(
  "gsc_breakdowns",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => gscProperties.id, { onDelete: "cascade" }),
    dimension: gscDimensionEnum("dimension").notNull(),
    searchType: gscSearchTypeEnum("search_type").notNull().default("web"),
    /** The search term, device type, or ISO country code. */
    keyValue: text("key_value").notNull(),

    /** The window these figures cover, inclusive. */
    windowStart: date("window_start").notNull(),
    windowEnd: date("window_end").notNull(),

    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    ctr: real("ctr").notNull(),
    position: real("position").notNull(),

    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Re-syncing the same window updates in place; a different window is a
    // separate set of rows, so history is kept rather than overwritten.
    uniqueIndex("gsc_breakdowns_unique_idx").on(
      table.propertyId,
      table.dimension,
      table.searchType,
      table.keyValue,
      table.windowStart,
      table.windowEnd,
    ),
    index("gsc_breakdowns_lookup_idx").on(table.propertyId, table.searchType, table.dimension, table.windowEnd),
  ],
);

/**
 * Google's own verdict for a URL, from the URL Inspection API.
 * PASS = indexed, FAIL = not indexed, PARTIAL = indexed with problems,
 * NEUTRAL = excluded for a reason that isn't an error.
 */
export const gscVerdictEnum = pgEnum("gsc_verdict", [
  "PASS",
  "PARTIAL",
  "FAIL",
  "NEUTRAL",
  "VERDICT_UNSPECIFIED",
]);

/**
 * Per-URL index coverage, straight from Google rather than inferred.
 *
 * This is the one source that can answer "is this page actually indexed, and
 * if not, why" -- our crawler can see a page is reachable and has no noindex,
 * and still be wrong about whether Google kept it. `coverageState` carries
 * Google's own sentence for the reason ("Crawled - currently not indexed",
 * "Duplicate without user-selected canonical", and so on).
 *
 * One row per URL, replaced on re-inspection: the API is quota-limited to
 * 2,000 URLs per property per day, so history would cost far more than it is
 * worth here. `inspectedAt` is what drives re-inspection scheduling.
 */
export const gscUrlInspections = pgTable(
  "gsc_url_inspections",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => gscProperties.id, { onDelete: "cascade" }),
    pageUrl: text("page_url").notNull(),
    /** Crawler-normalized form of pageUrl -- the join key. See gscPageMetrics. */
    normalizedUrl: text("normalized_url"),

    verdict: gscVerdictEnum("verdict").notNull(),
    /** Google's human-readable reason. The answer to "why isn't this indexed". */
    coverageState: text("coverage_state"),
    /** ALLOWED / DISALLOWED per robots.txt. */
    robotsTxtState: text("robots_txt_state"),
    /** INDEXING_ALLOWED, BLOCKED_BY_META_TAG, BLOCKED_BY_HTTP_HEADER, ... */
    indexingState: text("indexing_state"),
    /** SUCCESSFUL, SOFT_404, NOT_FOUND, SERVER_ERROR, REDIRECT_ERROR, ... */
    pageFetchState: text("page_fetch_state"),

    /**
     * The canonical Google actually chose, versus the one the page declares.
     * A mismatch is a high-value finding our crawler cannot detect on its own.
     */
    googleCanonical: text("google_canonical"),
    userCanonical: text("user_canonical"),

    lastCrawlTime: timestamp("last_crawl_time", { withTimezone: true }),
    /** MOBILE or DESKTOP -- which crawler Google used. */
    crawledAs: text("crawled_as"),
    /** Sitemaps Google associates with this URL. */
    sitemaps: jsonb("sitemaps").$type<string[]>(),
    /** Rich-result and AMP verdicts, kept whole for detail views. */
    raw: jsonb("raw").$type<Record<string, unknown>>(),

    inspectedAt: timestamp("inspected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("gsc_url_inspections_unique_idx").on(table.propertyId, table.pageUrl),
    index("gsc_url_inspections_verdict_idx").on(table.propertyId, table.verdict),
    index("gsc_url_inspections_normalized_idx").on(table.propertyId, table.normalizedUrl),
    index("gsc_url_inspections_inspected_idx").on(table.propertyId, table.inspectedAt),
  ],
);

/**
 * One row per URL Inspection API *call*, successful or not.
 *
 * Quota has to be counted from attempts, not results. Google charges for
 * every call it receives; `gscUrlInspections` only holds the ones that came
 * back with data, so counting stored inspections silently under-reports.
 * That produced the contradiction of the UI claiming "828 of 2,000 left"
 * while Google was already rejecting calls as over-quota.
 *
 * Deliberately minimal -- this is a meter, not a log. Rows older than a
 * couple of days are pruned, since the quota window is a single day.
 */
export const gscInspectionAttempts = pgTable(
  "gsc_inspection_attempts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => gscProperties.id, { onDelete: "cascade" }),
    /** False when the call errored -- it still consumed quota. */
    succeeded: boolean("succeeded").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("gsc_inspection_attempts_idx").on(table.propertyId, table.attemptedAt)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    eventType: text("event_type").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_events_entity_idx").on(table.entityType, table.entityId)],
);

/**
 * Sitemaps as Search Console reports them, one row per (property, path).
 *
 * A re-sync upserts on that pair, and paths Google stops returning are kept
 * rather than deleted -- whether to show stale entries is a display decision,
 * not a storage one. `contents` mirrors the API's per-content-type counts;
 * note Google has largely stopped populating `indexed`, so 0 there means
 * "unreported", not "nothing indexed".
 */
export const gscSitemaps = pgTable(
  "gsc_sitemaps",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => gscProperties.id, { onDelete: "cascade" }),
    /** The sitemap URL exactly as registered in Search Console. */
    path: text("path").notNull(),
    lastSubmitted: timestamp("last_submitted", { withTimezone: true }),
    lastDownloaded: timestamp("last_downloaded", { withTimezone: true }),
    /** True while Google has yet to process a freshly submitted sitemap. */
    isPending: boolean("is_pending").notNull().default(false),
    /** True for a sitemap index file that points at child sitemaps. */
    isSitemapsIndex: boolean("is_sitemaps_index").notNull().default(false),
    warnings: integer("warnings").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    /** Per-content-type counts (web, image, ...), straight from the API. */
    contents: jsonb("contents").$type<Array<{ type: string; submitted: number; indexed: number }>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("gsc_sitemaps_unique_idx").on(table.propertyId, table.path),
    index("gsc_sitemaps_property_id_idx").on(table.propertyId),
  ],
);

/**
 * Core Web Vitals per URL, from PageSpeed Insights v5 -- CrUX field data
 * where Google has it, a Lighthouse lab run otherwise.
 *
 * `source` records which one actually produced the stored numbers, since a
 * lab LCP and a field LCP are not comparable and the UI must say which it is
 * showing. INP only exists in field data (a lab run has no user input), so
 * `inpMs` is always null when source is "lab". One current row per
 * (website, url, strategy): a re-run upserts rather than keeping history --
 * this answers "how is the page doing now", not "how has it trended".
 */
export const webVitals = pgTable(
  "web_vitals",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    websiteId: uuid("website_id")
      .notNull()
      .references(() => websites.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** "mobile" | "desktop" -- which emulation PSI ran with. */
    strategy: text("strategy").notNull(),
    /** "field" | "lab" | "none" -- where the metrics came from. */
    source: text("source").notNull(),
    /** Lighthouse performance score 0-100; null when no lab run happened. */
    performanceScore: integer("performance_score"),
    lcpMs: integer("lcp_ms"),
    inpMs: integer("inp_ms"),
    cls: real("cls"),
    fcpMs: integer("fcp_ms"),
    ttfbMs: integer("ttfb_ms"),
    /** Google's per-metric verdicts, e.g. { LCP: "FAST" }. */
    categories: jsonb("categories").$type<Record<string, string>>(),
    /** Google's overall_category: "FAST" | "AVERAGE" | "SLOW"; null in lab. */
    overall: text("overall"),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("web_vitals_unique_idx").on(table.websiteId, table.url, table.strategy),
    index("web_vitals_website_id_idx").on(table.websiteId),
  ],
);

/**
 * Latest Safe Browsing verdict for a site -- a status, not a log.
 *
 * One row per website (unique on website_id), UPSERTed by every check: the
 * question this answers is "is the site flagged right now", and history would
 * only blur that. `status` is "clean" | "flagged" | "unavailable" -- the last
 * is the honest answer when no GOOGLE_API_KEY is configured, so the UI never
 * shows an unchecked site as safe. `threats` is [] when clean.
 */
export const securityChecks = pgTable(
  "security_checks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    websiteId: uuid("website_id")
      .notNull()
      .references(() => websites.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    /** Safe Browsing matches: threatType + the specific URL flagged. */
    threats: jsonb("threats").$type<Array<{ threatType: string; url: string }>>(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("security_checks_unique_idx").on(table.websiteId),
    index("security_checks_website_id_idx").on(table.websiteId),
  ],
);
