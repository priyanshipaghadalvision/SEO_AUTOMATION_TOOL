# Spec — GSC Data Integrations (6 tabs)

Tier B retrofit of `seo-automation`. Six new data surfaces in `GscDataPanel`, driven by five parallel slices with **strict file ownership** (no two slices touch the same file). This document IS the contract: every endpoint shape, table, and type below is final — build to it exactly.

## Data-source reality (do not deviate)

| Requested | Google API status | What we build |
|---|---|---|
| Sitemaps | ✅ Real GSC API (`GET /sites/{siteUrl}/sitemaps`, webmasters v3) | Live sync into `gsc_sitemaps` |
| Core Web Vitals | Via **PageSpeed Insights v5** (CrUX field data + Lighthouse lab). FID is retired → **INP** | On-demand runs into `web_vitals` |
| Mobile Usability | ❌ API retired by Google (Dec 2023) | Crawl-derived viewport coverage + mobile CWV |
| Links | ❌ No GSC API | Crawl link graph: top linked pages, orphans, outbound domains |
| Enhancements | ❌ No GSC API | Crawl `structured_data` aggregation by schema.org type |
| Manual Actions / Security | ❌ No GSC API | Safe Browsing v4 check (needs `GOOGLE_API_KEY`; graceful "unavailable" without) + deep links to GSC UI |

Each tab states its data source in a one-line caption — never imply GSC provided what it didn't.

## Slices & file ownership

> **Plan review round 1: REVISE → fixes below applied verbatim (crawl-status casing, `@type` grouping, apiFetch export, db path, Safe Browsing `client` object, C2 panel gating, contract patches). Proceeding per reviewer's minimal fix list.**

| Slice | Owns (ONLY these files) | Depends on |
|---|---|---|
| S1 schema | `server/src/db/schema.ts` (append 3 tables **+ FK indexes per house style**) | — |
| S2 modules | NEW `server/src/gsc/sitemapsSync.ts`, `webVitals.ts`, `safeBrowsing.ts`, `siteInsights.ts` **+ ONE one-word edit to `server/src/gsc/client.ts`: add `export` before `async function apiFetch` — change nothing else in that file** | contract |
| S3 routes | `server/src/routes/gsc.ts` (append 8 endpoints) | contract |
| C1 client | `src/api/client.ts` (append types + 8 fns) | contract |
| C2 UI | `src/components/GscDataPanel.tsx` + `GscDataPanel.css` | contract |

Integration (main Claude): `drizzle-kit generate` + migrate, typecheck, drift-fix, real-data sync, build. **Nobody runs migrations, dev servers, or DELETE/DROP/TRUNCATE SQL. All schema changes are additive.**

## DB tables (S1 — append to schema.ts, style-matched to existing)

```
gscSitemaps "gsc_sitemaps"
  id uuid pk default gen_random_uuid()
  propertyId uuid notnull -> gsc_properties.id ON DELETE cascade
  path text notnull
  lastSubmitted timestamptz | lastDownloaded timestamptz
  isPending boolean default false | isSitemapsIndex boolean default false
  warnings integer default 0 | errors integer default 0
  contents jsonb  // [{ type, submitted, indexed }]
  fetchedAt timestamptz defaultNow
  UNIQUE (property_id, path)

webVitals "web_vitals"
  id uuid pk | websiteId uuid notnull -> websites.id ON DELETE cascade
  url text notnull | strategy text notnull  // "mobile" | "desktop"
  source text notnull                       // "field" | "lab" | "none"
  performanceScore integer                  // Lighthouse 0-100, null if absent
  lcpMs integer | inpMs integer | cls real | fcpMs integer | ttfbMs integer
  categories jsonb                          // { LCP: "FAST", ... } per-metric category
  overall text                              // "FAST" | "AVERAGE" | "SLOW" | null
  collectedAt timestamptz defaultNow
  UNIQUE (website_id, url, strategy)

securityChecks "security_checks"
  id uuid pk | websiteId uuid notnull -> websites.id ON DELETE cascade
  status text notnull    // "clean" | "flagged" | "unavailable"
  threats jsonb          // ThreatRow[], [] when clean
  checkedAt timestamptz defaultNow
  UNIQUE (website_id)    // one current status per site; checks UPSERT this row
```

S1 also adds a plain `index(...)` on each FK column (`property_id` / `website_id`), matching the house style used by existing tables.

## Endpoints (S3 — on existing `gscRouter`, same auth/ownership pattern as `/metrics/:websiteId`)

All follow existing conventions: ownership via join `websites.userId = req.userId`; 404 body is exactly `{ error: "not_found" }` (match `gsc.ts` `/metrics/:websiteId`); other errors `{ error: string }`. **`/links`, `/enhancements`, `/mobile` with no completed crawl return 200 with zeros/empty rows — never an error** (C2 renders an empty state, not a toast).

1. `POST /sitemaps/:websiteId/sync` → calls S2 `syncSitemaps(userId, websiteId)` → `{ synced: number, sitemaps: SitemapRow[] }`
2. `GET /sitemaps/:websiteId` → from DB → `{ gscLinked: boolean, sitemaps: SitemapRow[], fetchedAt: string|null }`
3. `POST /cwv/:websiteId/run` body `{ limit?: number (default 10, max 25), strategy?: "mobile"|"desktop" (default "mobile") }` → S2 `runWebVitals` → `{ tested, failed, stoppedReason: string|null, rows: CwvRow[] }`
4. `GET /cwv/:websiteId?strategy=mobile` → from DB ordered by lcpMs desc nulls last → `{ rows: CwvRow[], collectedAt: string|null }`
5. `GET /links/:websiteId?view=pages|domains|orphans&limit=100&offset=0` → S2 `getLinkInsights` → `{ view, total: number, offset, limit, rows: LinkPageRow[]|LinkDomainRow[]|OrphanRow[] }`
6. `GET /enhancements/:websiteId` → S2 `getEnhancements` → `{ totalPages, pagesWithData, pagesWithNone, types: EnhancementTypeRow[] }`
7. `GET /mobile/:websiteId` → S2 `getMobileUsability` → `{ totalPages, withViewport, missingViewport, missingViewportRows: {url, title}[] (cap 100), cwv: CwvRow[] (strategy=mobile) }`
8. `GET /security/:websiteId` + `POST /security/:websiteId/check` → `{ status, threats: unknown[], checkedAt: string|null, gscLinks: { manualActions: string, securityIssues: string } }` — links are `https://search.google.com/search-console/manual-actions` and `.../security-issues` (no resource param needed; user picks property in GSC UI).

## Shared row types (identical in S2/S3/C1)

```ts
SitemapRow { path: string; lastSubmitted: string|null; lastDownloaded: string|null;
  isPending: boolean; isSitemapsIndex: boolean; warnings: number; errors: number;
  contents: Array<{ type: string; submitted: number; indexed: number }>; }

CwvRow { url: string; strategy: string; source: "field"|"lab"|"none";
  performanceScore: number|null; lcpMs: number|null; inpMs: number|null;
  cls: number|null; fcpMs: number|null; ttfbMs: number|null;
  categories: Record<string,string>; overall: string|null; collectedAt: string; }

LinkPageRow   { url: string; title: string|null; inboundLinks: number; depth: number|null; }
LinkDomainRow { domain: string; links: number; sourcePages: number; }
OrphanRow     { url: string; title: string|null; depth: number|null; }
EnhancementTypeRow { type: string; pages: number; items: number; sampleUrls: string[] (≤3); }
ThreatRow { threatType: string; url: string; }   // from Safe Browsing match.threatType + match.threat.url
```

## S2 module specs

- **Reuse** `apiFetch` from `server/src/gsc/client.ts` — it is currently module-private; S2's one allowed edit to that file is adding `export` to it (nothing else). Import `db` from `../db/client.js` (the actual path — there is no `db/index.ts`; match `syncMetrics.ts`).
- `sitemapsSync.ts` — GSC `GET /sites/{encodeURIComponent(siteUrl)}/sitemaps`; upsert per (propertyId, path) with `onConflictDoUpdate`; never delete rows for paths Google no longer returns (keep history; that is a display concern).
- `webVitals.ts` — PSI: `GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=<enc>&strategy=<s>&category=performance` (+`&key=` from `PSI_API_KEY` ?? `GOOGLE_API_KEY` if set). Field data from `loadingExperience.metrics`: LARGEST_CONTENTFUL_PAINT_MS, INTERACTION_TO_NEXT_PAINT, CUMULATIVE_LAYOUT_SHIFT_SCORE (value/100 → cls), FIRST_CONTENTFUL_PAINT_MS, EXPERIMENTAL_TIME_TO_FIRST_BYTE; each `{percentile, category}`; `overall_category`. Lab fallback (no field data): `lighthouseResult.audits["largest-contentful-paint"|"interactive"→skip|"cumulative-layout-shift"|"first-contentful-paint"|"server-response-time"].numericValue` + `categories.performance.score*100`; source="lab"; INP null in lab. URL selection: top-impression pages from `gsc_page_metrics` (sum impressions group by page_url desc) else homepage + top crawled by inboundLinkCount. Sequential, ≥1.5s apart, stop on 429 → stoppedReason (PSI unkeyed quota is tiny — surface honestly). Upsert per (websiteId, url, strategy).
- `safeBrowsing.ts` — no `GOOGLE_API_KEY` → upsert+return "unavailable" WITHOUT calling. Else POST `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=` with body `{ client: { clientId: "seo-automation", clientVersion: "1.0.0" }, threatInfo: { threatTypes: [MALWARE, SOCIAL_ENGINEERING, UNWANTED_SOFTWARE, POTENTIALLY_HARMFUL_APPLICATION], platformTypes: [ANY_PLATFORM], threatEntryTypes: [URL], threatEntries: [...] } }` — the top-level `client` object is REQUIRED or Google 400s. Entries: site homepage + up to 20 top pages. Matches → "flagged" + `ThreatRow[]`. Persistence: UPSERT the single `security_checks` row per website (unique on website_id).
- `siteInsights.ts` — pure SQL over latest completed crawl: **`status = 'COMPLETED'` — the enum is UPPERCASE** (`crawlStatusEnum` in schema.ts); lowercase silently matches nothing. (`crawls.website_id = X AND status = 'COMPLETED' ORDER BY started_at DESC LIMIT 1`):
  - links/pages: `ORDER BY inbound_link_count DESC NULLS LAST, id` + total count; http_status 200 only.
  - links/domains: `SELECT substring(l->>'url' FROM '^https?://([^/]+)') AS domain, count(*) links, count(DISTINCT p.id) source_pages FROM pages p, jsonb_array_elements(coalesce(p.external_links,'[]'::jsonb)) l WHERE crawl_id=$1 GROUP BY 1 HAVING substring(...) IS NOT NULL ORDER BY links DESC` + total via subquery.
  - links/orphans: `inbound_link_count = 0 AND depth > 0 AND http_status = 200`, ordered by url.
  - enhancements: unnest `structured_data`. The items are raw parsed JSON-LD, so the grouping key is **`@type`** (never `type`) and it can be a string OR an array: group by `coalesce(item->>'@type', item->'@type'->>0)`. Items with no resolvable `@type` (e.g. bare `@graph` wrappers) are skipped, and a `pagesWithUntyped` count is NOT needed — just skip them. pages=count distinct page, items=count(*), sampleUrls=(array_agg url)[1:3]; plus counts of pages with/without any structured data (status 200 only).
  - mobile: viewport coverage over status-200 pages: `viewport IS NOT NULL AND viewport <> ''`.
  - Stable ordering everywhere (tiebreak `id`). All reads. Zero writes.

## C1 client fns (9 functions, append, matching existing `request<T>` style)

`getGscSitemaps(websiteId)`, `syncGscSitemaps(websiteId)`, `getWebVitals(websiteId, strategy?)`, `runWebVitals(websiteId, opts?)`, `getSiteLinks(websiteId, {view, limit, offset})`, `getGscEnhancements(websiteId)`, `getMobileUsability(websiteId)`, `getSecurityStatus(websiteId)`, `runSecurityCheck(websiteId)` — paths `/gsc/...` per S3 (9 handlers total). Export all row types above.

## C2 UI

Extend `GscTab` union + `GSC_TABS` (ONLY in GscDataPanel.tsx — SitePage sidebar picks the list up automatically):
`vitals` "Core Web Vitals", `sitemaps` "Sitemaps", `links` "Links", `enhancements` "Enhancements", `mobile` "Mobile", `security` "Security".

**CRITICAL panel-gating rule (F7):** `GscDataPanel` today fetches `getGscMetrics` unconditionally and gates the whole body behind its loading / error / "No data stored yet — hit Sync" states. The six new tabs MUST bypass that fetch and those gates entirely (early-return the new tab's component before the metrics-dependent branches; skip the metrics fetch when `tab` is one of the six new keys). Links/Enhancements/Mobile need no GSC link at all and must render even when the metrics call would 404. Each new tab owns its own loading/error/empty state, and each empty state names its real source: crawl-derived tabs say "Run a crawl…", vitals says "Run a check — data comes from PageSpeed Insights", sitemaps says "Hit Sync — fetched from Search Console", security says what the check needs.

Per-tab (all reuse `Pagination`, `.panel-summary`, `.panel-search`, `.gsc-table-wrap`, `.gsc-metric-table`, chip patterns; add new CSS to GscDataPanel.css using existing custom properties):

- **VitalsTab** — "Run check (top 10)" button → `runWebVitals`; table URL | Score | LCP | INP | CLS | FCP | TTFB | Overall. Color chips by Google thresholds: LCP ≤2500 good ≤4000 ni else poor; INP ≤200/≤500; CLS ≤0.1/≤0.25; render ms as `1.8 s`, cls 2dp. Legend row. Caption: "Field data from Chrome UX Report via PageSpeed Insights; lab fallback where Google has no field data." stoppedReason surfaced as warning. Client-side sort by column click (rows ≤ a few dozen), pagination client-side.
- **SitemapsTab** — Sync button; cards/table: path, submitted count (sum contents[].submitted), indexed (sum indexed; show "—" when Google returns 0/absent — Google stopped reporting it), errors/warnings badges (red/amber), lastSubmitted/lastDownloaded relative dates, "sitemap index" chip.
- **LinksTab** — segmented switcher [Top linked pages | Outbound domains | Orphan pages]; server-side Pagination (total from response); search box filters client-side within page is NOT ok — omit search, keep switcher+pager. Caption: "From the latest crawl's link graph — Google Search Console does not expose links via API."
- **EnhancementsTab** — coverage stat cards (pages with structured data / without), table: Type | Pages | Items | Sample URLs. Caption re: source = crawl.
- **MobileTab** — three stat cards (Total pages / With viewport / Missing viewport with % ), missing-viewport table (client-paged), then mobile CWV table (reuse the Vitals table renderer). Caption: Google retired the Mobile Usability API (Dec 2023); this is crawl + field data.
- **SecurityTab** — status hero card: green "No threats detected" / red flagged with threat list / gray "Automated check unavailable (no GOOGLE_API_KEY)"; check button; two outbound link cards to GSC Manual actions + Security issues UIs. Caption: manual actions are not exposed by any Google API.

Empty states per brief ("No data yet — hit Sync/Run…"). Loading = existing "Loading…" muted text pattern. Errors = `.error-text` + retry via re-click. Responsive: tables already scroll in `.gsc-table-wrap`.

## Hard rules

- No file outside your slice. No migrations run by agents. No dev servers. No DELETE/DROP/TRUNCATE anywhere. Additive only.
- TypeScript strict must pass; do not weaken tsconfig or eslint.
- Comments follow existing style: explain constraints, not narration.
```
