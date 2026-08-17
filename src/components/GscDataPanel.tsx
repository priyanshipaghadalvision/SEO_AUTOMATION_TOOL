import { Fragment, useEffect, useMemo, useState } from "react";
import type {
  CoverageReasonRow,
  CoverageResponse,
  Crawl,
  CwvRow,
  EnhancementsResponse,
  GscBreakdownRow,
  GscInspection,
  GscInspectionRunResult,
  GscMetricsResponse,
  GscPageMetric,
  GscSitemapsResponse,
  GscVerdict,
  Issue,
  LinkDomainRow,
  LinkPageRow,
  MobileUsabilityResponse,
  Optimization,
  OrphanRow,
  PageSummary,
  SecurityStatusResponse,
  SiteLinksResponse,
  SitemapRow,
  WebVitalsResponse,
  WebVitalsRunResult,
} from "../api/client";
import {
  getCoverage,
  getCrawl,
  getCrawlIssues,
  getCrawlOptimizations,
  getCrawlPages,
  crawlGscReason,
  getGscEnhancements,
  getGscMetrics,
  getGscSitemaps,
  getMobileUsability,
  getSecurityStatus,
  getSiteLinks,
  getWebVitals,
  inspectGscUrls,
  runSecurityCheck,
  runWebVitals,
  syncGscSitemaps,
} from "../api/client";
import { DateRangePicker } from "./DateRangePicker";
import type { Range } from "./DateRangePicker";
import { SpinnerIcon } from "./icons";
import { Pagination } from "./Pagination";
import "./Panel.css";
import "./GscDataPanel.css";

export type GscTab =
  | "overview"
  | "indexing"
  | "pages"
  | "queries"
  | "segments"
  | "vitals"
  | "sitemaps"
  | "links"
  | "enhancements"
  | "mobile"
  | "security"
  | "coverage";

/**
 * Exported so each host renders its own tab affordance -- the modal uses a
 * horizontal strip, the site page folds these into its sidebar. The panel
 * itself is deliberately tab-agnostic: it takes the active tab as a prop and
 * renders that section, so neither host owns a copy of this list.
 */
export const GSC_TABS: Array<{ key: GscTab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "indexing", label: "Indexing" },
  { key: "pages", label: "Pages" },
  { key: "queries", label: "Queries" },
  { key: "segments", label: "Devices & Countries" },
  { key: "vitals", label: "Core Web Vitals" },
  { key: "sitemaps", label: "Sitemaps" },
  { key: "links", label: "Links" },
  { key: "enhancements", label: "Enhancements" },
  { key: "mobile", label: "Mobile" },
  { key: "security", label: "Security" },
  { key: "coverage", label: "Index coverage" },
];

/**
 * Tabs fed by the crawl, PageSpeed Insights or Safe Browsing rather than the
 * stored Search Analytics payload. They must neither trigger nor sit behind
 * the getGscMetrics fetch: Links/Enhancements/Mobile need no GSC property at
 * all, and for an unlinked site that call 404s and would blank the panel.
 */
const INSIGHT_TABS: ReadonlySet<GscTab> = new Set([
  "vitals",
  "sitemaps",
  "links",
  "mobile",
  "security",
  "coverage",
]);

const VERDICT_LABEL: Record<GscVerdict, string> = {
  PASS: "Indexed",
  PARTIAL: "Indexed with issues",
  FAIL: "Not indexed",
  NEUTRAL: "Excluded",
  VERDICT_UNSPECIFIED: "Unknown",
};

/**
 * Rows rendered per page.
 *
 * This used to be a hard cap that showed the top 250 and named the rest only
 * as a count -- 3,378 queries with 3,128 of them unreachable. It is now a page
 * size: the pager walks the whole set, and the DOM still only ever holds one
 * page of rows.
 */
const ROW_LIMIT = 100;

/**
 * Every Search Console view, minus any shell.
 *
 * Owns the data fetch, the date range and the section bodies; owns no chrome
 * -- no backdrop, no close button, no tab strip. That split is what lets the
 * modal and the site page show identical data without a second copy of this
 * logic drifting out of sync with the first.
 */
export function GscDataPanel({
  websiteId,
  domain,
  tab,
}: {
  websiteId: string;
  domain: string;
  /** Controlled by the host, which renders its own tab affordance. */
  tab: GscTab;
}) {
  const [data, setData] = useState<GscMetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // null until the first response tells us what Google's newest settled day
  // is -- guessing it client-side would drift from the server's clamp.
  const [range, setRange] = useState<Range | null>(null);
  const [rangeBusy, setRangeBusy] = useState(false);
  const [searchType, setSearchType] = useState<"web" | "image">("web");

  const insightTab = INSIGHT_TABS.has(tab);

  useEffect(() => {
    // Insight tabs own their data end to end -- fetching metrics here would
    // spend quota for nothing and gate them behind states they never read.
    if (insightTab) return;
    let cancelled = false;
    // A range change may need a live Google fetch, so the whole panel shows a
    // busy state rather than leaving stale numbers under a new date label.
    if (range) setRangeBusy(true);
    setError(null);

    getGscMetrics(websiteId, range ? { start: range.start, end: range.end } : undefined, searchType)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        // Adopt whatever the server resolved to -- it clamps for Google's
        // 3-day lag and 16-month limit, so the picker must reflect that.
        setRange({ start: res.range.startDate, end: res.range.endDate });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load Search Console data.");
      })
      .finally(() => {
        // Deliberately NOT guarded by `cancelled`. These are local state
        // flags, and skipping them on a superseded request is exactly what
        // left the picker permanently greyed out: one aborted or slow fetch
        // and every control stayed disabled until a page refresh.
        setLoading(false);
        setRangeBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // Intentionally keyed on the range *values*: including the object would
    // re-fetch on every render, and adopting the server's range would loop.
    // `insightTab` is a dep so that leaving an insight tab starts the fetch
    // that was skipped while it was active.
  }, [websiteId, range?.start, range?.end, insightTab, searchType]);

  /** Re-reads everything after an inspection batch adds rows. */
  async function reload() {
    setData(await getGscMetrics(websiteId, range ? { start: range.start, end: range.end } : undefined, searchType));
  }

  // Clearing the filter when switching tabs avoids the confusing state where
  // a tab looks empty because a term typed on a different tab still applies.
  useEffect(() => setSearch(""), [tab]);

  // Insight tabs render before -- and entirely outside -- the metrics
  // loading/error/"No data stored yet" gates below. Each owns its own
  // loading, error and empty state, sourced from what actually feeds it.
  if (insightTab) {
    return (
      <div className="gsc-panel">
        <div className="gsc-panel-body">
          {tab === "vitals" && <VitalsTab websiteId={websiteId} />}
          {tab === "sitemaps" && <SitemapsTab websiteId={websiteId} />}
          {tab === "links" && <LinksTab websiteId={websiteId} />}
          {tab === "mobile" && <MobileTab websiteId={websiteId} />}
          {tab === "security" && <SecurityTab websiteId={websiteId} />}
          {tab === "coverage" && <CoverageTab websiteId={websiteId} />}
        </div>
      </div>
    );
  }

  return (
    <div className="gsc-panel">
      <div className="gsc-panel-bar">
        <p className="muted small gsc-panel-source">
          {data?.property.siteUrl ?? domain}
          {data?.totals?.firstDate && ` · ${data.totals.firstDate} to ${data.totals.lastDate}`}
        </p>
        {data && (
          <div className="gsc-panel-controls">
            <div className="gsc-search-type-toggle" role="group" aria-label="Google Search type">
              {(["web", "image"] as const).map((type) => (
                <button key={type} type="button" className={searchType === type ? "active" : ""} onClick={() => setSearchType(type)} disabled={rangeBusy}>
                  {type === "web" ? "Web" : "Image search"}
                </button>
              ))}
            </div>
            <DateRangePicker
              value={range ?? { start: data.range.startDate, end: data.range.endDate }}
              latestAvailable={data.range.latestAvailable}
              busy={rangeBusy}
              onChange={setRange}
            />
          </div>
        )}
      </div>

      {data?.range.clampedReason && (
        <p className="small gsc-range-note">Adjusted: {data.range.clampedReason}.</p>
      )}
      {data?.partial && (
        <p className="small opt-warning">
          Couldn&rsquo;t reach Google for this range — showing stored data only, which may not cover the whole
          period.
        </p>
      )}
      {data && (
        <p className="small gsc-provisional-note">
          Fresh data from {data.range.provisionalStart} to {data.range.endDate} is provisional and may be restated by Google.
        </p>
      )}

      <div className="gsc-panel-body">
        {loading && <p className="muted small">Loading Search Console data&hellip;</p>}
        {rangeBusy && !loading && (
          <p className="muted small">Loading {range?.start} to {range?.end}&hellip;</p>
        )}
        {error && <p className="error-text">{error}</p>}

        {data && !loading && !data.totals?.impressions && tab !== "indexing" && (
          <p className="muted small">
            No data stored yet for this property. Hit <strong>Sync</strong> on the Search Console card first.
          </p>
        )}

        {/* Indexing works with no traffic data at all -- a site with zero
              impressions is exactly the case where "why isn't this indexed"
              matters most, so this tab renders regardless. */}
        {data && !loading && tab === "indexing" && (
          <IndexingTab websiteId={websiteId} data={data} onRefresh={reload} />
        )}

        {data && !loading && !!data.totals?.impressions && (
          <>
            {tab === "overview" && <Overview data={data} />}

            {tab === "pages" && (
              <FilteredTable
                placeholder="Filter by URL…"
                value={search}
                onChange={setSearch}
                total={data.pages.length}
                noun="page"
                plural="pages"
                head="Page"
                rows={filterRows(data.pages, search, (p) => p.pageUrl).map((p) => ({
                  key: p.pageUrl,
                  label: p.pageUrl,
                  href: p.pageUrl,
                  ...p,
                }))}
              />
            )}

            {tab === "queries" &&
              (data.queries.length === 0 ? (
                <p className="muted small">
                  No query data stored. Re-run <strong>Sync</strong> — queries were added after your last sync.
                </p>
              ) : (
                <FilteredTable
                  placeholder="Filter by search term…"
                  value={search}
                  onChange={setSearch}
                  total={data.queries.length}
                  noun="query"
                  plural="queries"
                  head="Search query"
                  rows={filterRows(data.queries, search, (q) => q.keyValue).map((q) => ({
                    key: q.keyValue,
                    label: q.keyValue,
                    ...q,
                  }))}
                />
              ))}

            {tab === "segments" && <Segments devices={data.devices} countries={data.countries} />}
          </>
        )}
        {data && !loading && tab === "enhancements" && <EnhancementsTab websiteId={websiteId} searchAppearances={data.searchAppearances} searchType={data.searchType} />}
      </div>
    </div>
  );
}

/**
 * Index coverage: what Google actually did with each URL, and why.
 *
 * Runs in batches because the URL Inspection API allows 2,000 URLs per
 * property per day. The run result reports how many remain and how much
 * quota is left, so a partially-checked site never looks fully checked.
 */
function IndexingTab({
  websiteId,
  data,
  onRefresh,
}: {
  websiteId: string;
  data: GscMetricsResponse;
  onRefresh: () => Promise<void>;
}) {
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<GscInspectionRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetedCrawl, setTargetedCrawl] = useState<{ urlsQueued: number; crawlId: string } | null>(null);
  const [targetedCrawlBusy, setTargetedCrawlBusy] = useState(false);
  const [filter, setFilter] = useState<GscVerdict | "all">("all");
  const [reasonFilter, setReasonFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [inspOffset, setInspOffset] = useState(0);
  const [inspPageSize, setInspPageSize] = useState(ROW_LIMIT);

  // A verdict card or a search term changes which rows exist, so the page
  // number has to restart or it lands past the end of the new list.
  useEffect(() => setInspOffset(0), [filter, reasonFilter, search]);

  async function inspect(batchSize: number) {
    setRunning(true);
    setError(null);
    try {
      setRun(await inspectGscUrls(websiteId, batchSize));
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Inspection failed.");
    } finally {
      setRunning(false);
    }
  }

  async function crawlExcludedUrls() {
    setTargetedCrawlBusy(true);
    setError(null);
    try {
      if (reasonFilter === null) return;
      const result = await crawlGscReason(websiteId, reasonFilter, rows.map((row) => row.pageUrl));
      setTargetedCrawl({ urlsQueued: result.urlsQueued, crawlId: result.crawl.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue the targeted crawl.");
    } finally {
      setTargetedCrawlBusy(false);
    }
  }

  const byVerdict = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of data.coverage) counts[c.verdict] = (counts[c.verdict] ?? 0) + c.count;
    return counts;
  }, [data.coverage]);

  // Search Console's Page Indexing report has two headline totals, while the
  // URL Inspection API gives us four verdicts. Keep the arithmetic visible so
  // a clean PASS count is never mistaken for Google's complete "Indexed"
  // total: PARTIAL URLs are indexed too, and NEUTRAL URLs are excluded.
  const gscIndexed = (byVerdict.PASS ?? 0) + (byVerdict.PARTIAL ?? 0);
  const gscNotIndexed = (byVerdict.FAIL ?? 0) + (byVerdict.NEUTRAL ?? 0);

  // Reasons, most common first -- the actionable summary of "why not indexed".
  const reasons = useMemo(
    () =>
      [...data.coverage]
        .filter((c) => c.coverageState)
        .sort((a, b) => b.count - a.count)
        .slice(0, 12),
    [data.coverage],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.inspections
      .filter((i) => filter === "all" || i.verdict === filter)
      .filter((i) => reasonFilter === null || i.coverageState === reasonFilter)
      .filter((i) => !q || i.pageUrl.toLowerCase().includes(q) || (i.coverageState ?? "").toLowerCase().includes(q));
  }, [data.inspections, filter, reasonFilter, search]);

  const total = data.inspections.length;
  const selectedReason = reasons.find((reason) => reason.coverageState === reasonFilter) ?? null;
  const canCrawlSelectedReason = selectedReason?.verdict === "NEUTRAL" && rows.length > 0;

  return (
    <div className="gsc-overview">
      <div className="gsc-index-toolbar">
        <div>
          <div className="gsc-index-totals" aria-label="Search Console equivalent totals">
            <span>
              Inspected indexed: <strong>{gscIndexed.toLocaleString()}</strong>
              <small> ({(byVerdict.PASS ?? 0).toLocaleString()} clean + {(byVerdict.PARTIAL ?? 0).toLocaleString()} with issues)</small>
            </span>
            <span>
              Inspected not indexed: <strong>{gscNotIndexed.toLocaleString()}</strong>
              <small> ({(byVerdict.FAIL ?? 0).toLocaleString()} not indexed + {(byVerdict.NEUTRAL ?? 0).toLocaleString()} excluded)</small>
            </span>
          </div>
          <div className="gsc-verdict-cards">
            {(["PASS", "PARTIAL", "FAIL", "NEUTRAL"] as GscVerdict[]).map((v) => (
              <button
                key={v}
                type="button"
                className={`gsc-verdict-card gsc-verdict-${v.toLowerCase()}${filter === v ? " gsc-verdict-active" : ""}`}
                onClick={() => setFilter(filter === v ? "all" : v)}
              >
                <span className="gsc-verdict-count">{(byVerdict[v] ?? 0).toLocaleString()}</span>
                <span className="gsc-verdict-label">{VERDICT_LABEL[v]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="gsc-index-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={running} onClick={() => inspect(50)}>
            {running ? (
              <>
                <SpinnerIcon /> Inspecting&hellip;
              </>
            ) : (
              "Check 1000 URLs"
            )}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={running} onClick={() => inspect(2000)}>
            Check 2000
          </button>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      {run && (
        <div className="opt-run-summary">
          <p className="small">
            Checked <strong>{run.inspected}</strong> URL{run.inspected === 1 ? "" : "s"}
            {run.failed > 0 && ` · ${run.failed} failed`} · <strong>{run.remaining.toLocaleString()}</strong> still
            unchecked
            {run.quotaDisagreement
              ? " · daily quota spent (Google's count, not ours)"
              : ` · ${run.quotaRemainingToday.toLocaleString()} of 2,000 daily inspections left`}
          </p>
          {run.stoppedReason && <p className="small opt-warning">{run.stoppedReason}</p>}
        </div>
      )}

      {total === 0 && !running && (
        <>
          <p className="muted small">
            Nothing checked yet. Google&rsquo;s URL Inspection API tells you whether each page is actually indexed
            and, if not, the exact reason. It allows <strong>2,000 URLs per day</strong> for this property, so it
            runs in batches — highest-traffic pages first, then pages your crawler found that Google has never sent
            traffic to.
          </p>
          <ImpliedIndexTable pages={data.pages} />
        </>
      )}

      {reasons.length > 0 && (
        <div>
          <h4 className="gsc-mini-title">Why Google decided that</h4>
          <div className="gsc-table-wrap">
            <table className="gsc-metric-table">
              <thead>
                <tr>
                  <th>Reason reported by Google</th>
                  <th className="gsc-th-num" style={{ width: 130 }}>Status</th>
                  <th className="gsc-th-num">URLs</th>
                </tr>
              </thead>
              <tbody>
                {reasons.map((r) => (
                  <tr
                    key={`${r.verdict}-${r.coverageState}`}
                    className={`gsc-reason-row${reasonFilter === r.coverageState ? " gsc-reason-row-active" : ""}`}
                    onClick={() => setReasonFilter(reasonFilter === r.coverageState ? null : r.coverageState)}
                    title={`Show URLs with: ${r.coverageState}`}
                  >
                    <td className="gsc-cell-label">{r.coverageState}</td>
                    <td className="gsc-cell-label">
                      <span className={`gsc-verdict-chip gsc-verdict-${r.verdict.toLowerCase()}`}>
                        {VERDICT_LABEL[r.verdict]}
                      </span>
                    </td>
                    <td className="gsc-cell-label">{r.count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {total > 0 && (
        <div>
          <div className="panel-summary">
            <span className="muted small">
              {rows.length.toLocaleString()} of {total.toLocaleString()} checked URL
              {total === 1 ? "" : "s"}
              {filter !== "all" && ` · ${VERDICT_LABEL[filter]}`}
              {reasonFilter !== null && ` · ${reasonFilter}`}
            </span>
            {reasonFilter !== null && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReasonFilter(null)}>
                Clear reason filter
              </button>
            )}
            {canCrawlSelectedReason && (
              <button type="button" className="btn btn-primary btn-sm" disabled={targetedCrawlBusy} onClick={crawlExcludedUrls}>
                {targetedCrawlBusy ? "Queuing crawl…" : `Crawl ${rows.length.toLocaleString()} URL${rows.length === 1 ? "" : "s"}`}
              </button>
            )}
            <input
              type="text"
              className="panel-search"
              placeholder="Filter by URL or reason…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {targetedCrawl && (
            <TargetedCrawlResults crawlId={targetedCrawl.crawlId} urlsQueued={targetedCrawl.urlsQueued} />
          )}
          <div className="gsc-table-wrap">
            <table className="gsc-metric-table gsc-index-table">
              <thead>
                <tr>
                  <th>URL</th>
                  <th style={{ width: 130 }}>Status</th>
                  <th>Reason</th>
                  <th style={{ width: 150 }}>Google&rsquo;s canonical</th>
                  <th style={{ width: 180 }}>Details</th>
                  <th style={{ width: 110 }}>Last crawled</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(inspOffset, inspOffset + inspPageSize).map((i) => (
                  <InspectionRow key={i.pageUrl} row={i} />
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="muted small gsc-truncated">Nothing matches that filter.</p>}
            {rows.length > 0 && (
              <Pagination
                total={rows.length}
                offset={inspOffset}
                pageSize={inspPageSize}
                noun="URL"
                plural="URLs"
                onChange={(next) => {
                  setInspOffset(next.offset);
                  setInspPageSize(next.pageSize);
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Indexed-by-proof, for when no inspection has run.
 *
 * A URL Google has shown in search results is indexed -- that is what being
 * shown means. Search Analytics carries that fact for every such page and
 * costs no inspection quota, so this answers "is it indexed" for the whole
 * traffic-earning set immediately, on a property whose 2,000 daily
 * inspections are spent.
 *
 * What it cannot do is speak for silence. A page with no impressions may be
 * unindexed, or indexed and simply never shown, and only the Inspection API
 * separates those -- along with the reason. So this table states what it
 * knows and says nothing about the rest, rather than implying the absent
 * pages are missing from the index.
 */
function ImpliedIndexTable({ pages }: { pages: GscPageMetric[] }) {
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(ROW_LIMIT);
  const [search, setSearch] = useState("");

  const rows = useMemo(() => filterRows(pages, search, (p) => p.pageUrl), [pages, search]);
  useEffect(() => setOffset(0), [search]);

  if (pages.length === 0) return null;

  return (
    <div>
      <h4 className="gsc-mini-title">Confirmed indexed &mdash; seen in Google search results</h4>
      <p className="muted small">
        {pages.length.toLocaleString()} URL{pages.length === 1 ? "" : "s"} appeared in search results during this
        date range, so Google has them indexed. This costs no inspection quota. Run the check above for verdicts and
        for the reasons behind pages that are <em>not</em> indexed.
      </p>

      <div className="panel-summary">
        <span className="muted small">{rows.length.toLocaleString()} shown</span>
        <input
          type="text"
          className="panel-search"
          placeholder="Filter by URL…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="gsc-table-wrap">
        <table className="gsc-metric-table">
          <thead>
            <tr>
              <th>URL</th>
              <th style={{ width: 130 }}>Status</th>
              <th className="gsc-th-num">Impressions</th>
              <th className="gsc-th-num">Clicks</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(offset, offset + pageSize).map((p) => (
              <tr key={p.pageUrl}>
                <td className="gsc-cell-label">
                  <a href={p.pageUrl} target="_blank" rel="noreferrer noopener" title={p.pageUrl}>
                    {p.pageUrl}
                  </a>
                </td>
                <td className="gsc-cell-label">
                  <span className="gsc-verdict-chip gsc-verdict-pass">Indexed</span>
                </td>
                <td className="gsc-td-num">{p.impressions.toLocaleString()}</td>
                <td className="gsc-td-num">{p.clicks.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted small gsc-truncated">Nothing matches that filter.</p>}
      </div>

      {rows.length > 0 && (
        <Pagination
          total={rows.length}
          offset={offset}
          pageSize={pageSize}
          noun="URL"
          plural="URLs"
          onChange={(next) => {
            setOffset(next.offset);
            setPageSize(next.pageSize);
          }}
        />
      )}
    </div>
  );
}

function InspectionRow({ row }: { row: GscInspection }) {
  // A canonical Google picked that differs from the declared one is a real
  // finding, and invisible to our own crawler -- so it is called out rather
  // than shown as just another URL.
  const canonicalMismatch =
    row.googleCanonical && row.userCanonical && row.googleCanonical !== row.userCanonical;

  return (
    <tr>
      <td className="gsc-cell-label">
        <a href={row.pageUrl} target="_blank" rel="noreferrer noopener" title={row.pageUrl}>
          {row.pageUrl}
        </a>
      </td>
      <td>
        <span className={`gsc-verdict-chip gsc-verdict-${row.verdict.toLowerCase()}`}>
          {VERDICT_LABEL[row.verdict]}
        </span>
      </td>
      <td className="gsc-cell-label" title={row.coverageState ?? ""}>
        {row.coverageState ?? "—"}
        {row.indexingState && row.indexingState !== "INDEXING_ALLOWED" && (
          <span className="gsc-sub-note">{row.indexingState.replace(/_/g, " ").toLowerCase()}</span>
        )}
        {row.pageFetchState && row.pageFetchState !== "SUCCESSFUL" && (
          <span className="gsc-sub-note">fetch: {row.pageFetchState.replace(/_/g, " ").toLowerCase()}</span>
        )}
      </td>
      <td className="gsc-cell-label" title={row.googleCanonical ?? ""}>
        {canonicalMismatch ? (
          <span className="gsc-canonical-warn" title={`Google chose ${row.googleCanonical}, page declares ${row.userCanonical}`}>
            differs
          </span>
        ) : !row.googleCanonical ? (
          <span className="muted">—</span>
        ) : !row.userCanonical ? (
          // Google always reports the canonical it picked, so a null on our
          // side means the page declared none -- not that the two agree.
          <span className="gsc-canonical-none" title={`Page declares no canonical; Google chose ${row.googleCanonical}`}>
            none declared
          </span>
        ) : (
          <span className="muted">same</span>
        )}
      </td>
      <td className="gsc-inspection-details">
        <InspectionDetails row={row} />
      </td>
      <td className="muted small nowrap">
        {row.lastCrawlTime ? new Date(row.lastCrawlTime).toLocaleDateString() : "never"}
      </td>
    </tr>
  );
}

function InspectionDetails({ row }: { row: GscInspection }) {
  const raw = row.raw ?? {};
  const referringUrls = Array.isArray(raw.referringUrls) ? raw.referringUrls : [];
  const rich = raw.richResults ?? null;
  const amp = raw.amp ?? null;
  const mobile = raw.mobileUsability ?? null;
  const richVerdict = typeof rich?.verdict === "string" ? rich.verdict : null;
  const ampVerdict = typeof amp?.verdict === "string" ? amp.verdict : null;
  const mobileVerdict = typeof mobile?.verdict === "string" ? mobile.verdict : null;
  const richTypes = richResultTypes(rich);

  return (
    <details className="gsc-detail-panel">
      <summary className="gsc-detail-chips">
        <span title={(row.sitemaps ?? []).join("\n")}>Sitemaps {(row.sitemaps ?? []).length}</span>
        <span title={referringUrls.join("\n")}>Refs {referringUrls.length}</span>
        {richVerdict ? <span title={richTypes.join(", ") || richVerdict}>Rich {formatApiLabel(richVerdict)}</span> : <span>Rich none</span>}
        {ampVerdict && <span>AMP {formatApiLabel(ampVerdict)}</span>}
        {mobileVerdict && <span>Mobile {formatApiLabel(mobileVerdict)}</span>}
      </summary>
      <div className="gsc-detail-body">
        <DetailList title="Sitemaps" values={row.sitemaps ?? []} />
        <DetailList title="Referring URLs" values={referringUrls} />
        {rich && <JsonDetail title="Rich results" value={rich} />}
        {amp && <JsonDetail title="AMP" value={amp} />}
        {mobile && <JsonDetail title="Mobile usability" value={mobile} />}
      </div>
      {raw.inspectionResultLink && (
        <a className="gsc-detail-link" href={raw.inspectionResultLink} target="_blank" rel="noreferrer noopener">
          Open in GSC
        </a>
      )}
    </details>
  );
}

function DetailList({ title, values }: { title: string; values: string[] }) {
  return (
    <div>
      <strong>{title}</strong>
      {values.length === 0 ? (
        <p className="muted small">None reported by Google.</p>
      ) : (
        <ul className="gsc-detail-list">
          {values.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function JsonDetail({ title, value }: { title: string; value: Record<string, unknown> }) {
  return (
    <div>
      <strong>{title}</strong>
      <pre className="gsc-json-detail">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

function richResultTypes(rich: Record<string, unknown> | null): string[] {
  const detectedItems = Array.isArray(rich?.detectedItems) ? rich.detectedItems : [];
  return detectedItems
    .map((item) => (typeof item === "object" && item && "richResultType" in item ? item.richResultType : null))
    .filter((type): type is string => typeof type === "string" && type.length > 0);
}

function formatApiLabel(value: string): string {
  return value.replace(/_/g, " ").toLowerCase();
}

function Overview({ data }: { data: GscMetricsResponse }) {
  const t = data.totals!;
  return (
    <div className="gsc-overview">
      <div className="gsc-stat-row">
        <Stat label="Clicks" value={t.clicks.toLocaleString()} />
        <Stat label="Impressions" value={t.impressions.toLocaleString()} />
        <Stat label="Average CTR" value={`${(t.ctr * 100).toFixed(2)}%`} />
        <Stat label="Average position" value={t.position.toFixed(1)} />
        <Stat label="Pages with traffic" value={t.pages.toLocaleString()} />
      </div>

      <TrendChart trend={data.trend} />

      <div className="gsc-overview-split">
        <MiniList title="Top pages" rows={data.pages.slice(0, 8).map((p) => ({ label: p.pageUrl, clicks: p.clicks, impressions: p.impressions }))} />
        <MiniList title="Top queries" rows={data.queries.slice(0, 8).map((q) => ({ label: q.keyValue, clicks: q.clicks, impressions: q.impressions }))} emptyHint="Re-sync to fetch queries." />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="gsc-stat">
      <span className="gsc-stat-value">{value}</span>
      <span className="gsc-stat-label">{label}</span>
    </div>
  );
}

/**
 * Daily clicks and impressions as an inline SVG.
 *
 * Impressions and clicks differ by orders of magnitude, so each series is
 * scaled to its own maximum -- a shared axis would flatten the clicks line
 * into the baseline and show nothing. The two are therefore comparable in
 * shape, not in height, which is what the labels say.
 */
function TrendChart({ trend }: { trend: GscMetricsResponse["trend"] }) {
  if (trend.length < 2) return null;

  const W = 900;
  const H = 150;
  const PAD = 4;
  const maxClicks = Math.max(...trend.map((d) => d.clicks), 1);
  const maxImpr = Math.max(...trend.map((d) => d.impressions), 1);
  const x = (i: number) => (i / (trend.length - 1)) * (W - PAD * 2) + PAD;
  const y = (v: number, max: number) => H - PAD - (v / max) * (H - PAD * 2);
  const path = (pick: (d: (typeof trend)[number]) => number, max: number) =>
    trend.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(pick(d), max).toFixed(1)}`).join(" ");

  return (
    <div className="gsc-chart">
      <div className="gsc-chart-legend">
        <span className="gsc-legend-item"><i className="gsc-swatch gsc-swatch-impr" /> Impressions (peak {maxImpr.toLocaleString()})</span>
        <span className="gsc-legend-item"><i className="gsc-swatch gsc-swatch-clicks" /> Clicks (peak {maxClicks.toLocaleString()})</span>
        <span className="muted small gsc-chart-note">each series scaled to its own peak</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="gsc-chart-svg" preserveAspectRatio="none" role="img"
        aria-label={`Daily clicks and impressions from ${trend[0]?.date} to ${trend[trend.length - 1]?.date}`}>
        <path d={path((d) => d.impressions, maxImpr)} className="gsc-line gsc-line-impr" />
        <path d={path((d) => d.clicks, maxClicks)} className="gsc-line gsc-line-clicks" />
      </svg>
      <div className="gsc-chart-axis">
        <span>{trend[0]?.date}</span>
        <span>{trend[trend.length - 1]?.date}</span>
      </div>
    </div>
  );
}

function MiniList({
  title,
  rows,
  emptyHint,
}: {
  title: string;
  rows: Array<{ label: string; clicks: number; impressions: number }>;
  emptyHint?: string;
}) {
  return (
    <div className="gsc-mini">
      <h4 className="gsc-mini-title">{title}</h4>
      {rows.length === 0 ? (
        <p className="muted small">{emptyHint ?? "Nothing recorded."}</p>
      ) : (
        <ul className="gsc-mini-list">
          {rows.map((r) => (
            <li key={r.label}>
              <span className="gsc-mini-label" title={r.label}>{r.label}</span>
              <span className="gsc-mini-num">{r.clicks.toLocaleString()}</span>
              <span className="gsc-mini-num muted">{r.impressions.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface MetricRow {
  key: string;
  label: string;
  href?: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

type SortKey = "clicks" | "impressions" | "ctr" | "position";

function MetricTable({ head, rows }: { head: string; rows: MetricRow[] }) {
  const [sort, setSort] = useState<SortKey>("clicks");
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(ROW_LIMIT);

  // Re-sorting reorders the whole set, so the old page number would point at
  // unrelated rows. Same when a filter changes the row count under us.
  useEffect(() => setOffset(0), [sort, rows.length]);

  const sorted = useMemo(() => {
    // Position is the one metric where lower is better, so it sorts ascending
    // while everything else sorts descending.
    const dir = sort === "position" ? 1 : -1;
    return [...rows].sort((a, b) => (a[sort] - b[sort]) * dir);
  }, [rows, sort]);

  const visible = useMemo(() => sorted.slice(offset, offset + pageSize), [sorted, offset, pageSize]);

  const header = (key: SortKey, label: string) => (
    <th
      className={`gsc-th-num gsc-th-sortable${sort === key ? " gsc-th-active" : ""}`}
      onClick={() => setSort(key)}
      role="button"
      aria-label={`Sort by ${label}`}
    >
      {label}
      {sort === key && <span className="gsc-sort-caret">{key === "position" ? "▲" : "▼"}</span>}
    </th>
  );

  return (
    <div className="gsc-table-wrap">
      <table className="gsc-metric-table">
        <thead>
          <tr>
            <th>{head}</th>
            {header("clicks", "Clicks")}
            {header("impressions", "Impressions")}
            {header("ctr", "CTR")}
            {header("position", "Position")}
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <tr key={r.key}>
              <td className="gsc-cell-label">
                {r.href ? (
                  <a href={r.href} target="_blank" rel="noreferrer noopener" title={r.label}>
                    {r.label}
                  </a>
                ) : (
                  <span title={r.label}>{r.label}</span>
                )}
              </td>
              <td className="gsc-cell-label">{r.clicks.toLocaleString()}</td>
              <td className="gsc-cell-label">{r.impressions.toLocaleString()}</td>
              <td className="gsc-cell-label">{(r.ctr * 100).toFixed(2)}%</td>
              <td className="gsc-cell-label">{r.position.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted small gsc-truncated">Nothing matches that filter.</p>}
      {rows.length > 0 && (
        <Pagination
          total={rows.length}
          offset={offset}
          pageSize={pageSize}
          noun="row"
          onChange={(next) => {
            setOffset(next.offset);
            setPageSize(next.pageSize);
          }}
        />
      )}
    </div>
  );
}

function Segments({ devices, countries }: { devices: GscBreakdownRow[]; countries: GscBreakdownRow[] }) {
  if (devices.length === 0 && countries.length === 0) {
    return (
      <p className="muted small">
        No device or country data stored. Re-run <strong>Sync</strong> — these were added after your last sync.
      </p>
    );
  }
  return (
    <div className="gsc-overview-split">
      <div>
        <h4 className="gsc-mini-title">Devices</h4>
        <MetricTable head="Device" rows={devices.map((d) => ({ key: d.keyValue, label: d.keyValue.toLowerCase(), ...d }))} />
      </div>
      <div>
        <h4 className="gsc-mini-title">Countries</h4>
        <MetricTable head="Country" rows={countries.map((c) => ({ key: c.keyValue, label: c.keyValue.toUpperCase(), ...c }))} />
      </div>
    </div>
  );
}

/**
 * A filter box above a metric table, with a count that follows the filter.
 *
 * The count reports the *matching* rows, not the dataset size. Showing
 * "3,378 queries" above 73 visible rows reads as a rendering bug rather than
 * a filter working, so the total is shown alongside it only while filtering.
 */
function FilteredTable({
  placeholder,
  value,
  onChange,
  total,
  noun,
  plural,
  head,
  rows,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  total: number;
  noun: string;
  /** Given explicitly -- naive +"s" turns "query" into "querys". */
  plural: string;
  head: string;
  rows: MetricRow[];
}) {
  const filtering = value.trim().length > 0;
  return (
    <>
      <div className="panel-summary">
        <span className="muted small">
          {rows.length.toLocaleString()} {rows.length === 1 ? noun : plural}
          {filtering ? ` matching “${value.trim()}” of ${total.toLocaleString()}` : " with impressions"}
        </span>
        <input
          type="text"
          className="panel-search"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <MetricTable head={head} rows={rows} />
    </>
  );
}

function filterRows<T>(rows: T[], term: string, pick: (row: T) => string): T[] {
  const q = term.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => pick(r).toLowerCase().includes(q));
}

export type { GscPageMetric };

/* ==========================================================================
 * Insight tabs -- crawl / PageSpeed Insights / Safe Browsing surfaces.
 *
 * None of these read the Search Analytics payload the tabs above share, and
 * three of them must work on sites with no GSC property linked at all, so
 * each owns its fetch, loading, error and empty state. Every tab carries a
 * one-line source caption -- Google retired or never offered APIs for most
 * of this, and the UI must not imply Search Console provided what it didn't.
 * ======================================================================== */

function errText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** "3 d ago" while it matters, a plain date once it no longer does. */
function relDate(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Sub-second values keep ms precision -- "0.2 s" would hide the INP bands. */
function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

type CwvGrade = "good" | "ni" | "poor";

/** Google's published Core Web Vitals thresholds, verbatim. */
function gradeCwv(metric: "lcp" | "inp" | "cls", v: number | null): CwvGrade | null {
  if (v === null) return null;
  if (metric === "lcp") return v <= 2500 ? "good" : v <= 4000 ? "ni" : "poor";
  if (metric === "inp") return v <= 200 ? "good" : v <= 500 ? "ni" : "poor";
  return v <= 0.1 ? "good" : v <= 0.25 ? "ni" : "poor";
}

/** Lighthouse's own bands, so the Score column agrees with PSI's UI. */
function gradeScore(score: number | null): CwvGrade | null {
  if (score === null) return null;
  return score >= 90 ? "good" : score >= 50 ? "ni" : "poor";
}

function gradeOverall(overall: string | null): CwvGrade | null {
  if (overall === "FAST") return "good";
  if (overall === "AVERAGE") return "ni";
  if (overall === "SLOW") return "poor";
  return null;
}

function CwvCell({ grade, text }: { grade: CwvGrade | null; text: string }) {
  return (
    <td className="gsc-cell-label">
      {grade ? <span className={`cwv-chip cwv-chip-${grade}`}>{text}</span> : <span className="muted">{text}</span>}
    </td>
  );
}

function StatCard({
  value,
  label,
  sub,
  tone,
}: {
  value: string;
  label: string;
  sub?: string;
  tone?: "good" | "warn" | "bad";
}) {
  return (
    <div className={`gsc-stat-card${tone ? ` gsc-stat-card-${tone}` : ""}`}>
      <span className="gsc-stat-card-value">{value}</span>
      <span className="gsc-stat-card-label">{label}</span>
      {sub && <span className="gsc-stat-card-sub">{sub}</span>}
    </div>
  );
}

type CwvSortKey = "performanceScore" | "lcpMs" | "inpMs" | "cls" | "fcpMs" | "ttfbMs";

/**
 * The vitals table, shared by the Core Web Vitals tab and the Mobile tab.
 * Sorts worst-first -- these are problem-finding tables -- with unmeasured
 * (null) values sinking to the bottom regardless of the active column.
 */
function CwvTable({ rows }: { rows: CwvRow[] }) {
  const [sort, setSort] = useState<CwvSortKey>("lcpMs");
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(ROW_LIMIT);

  useEffect(() => setOffset(0), [sort, rows.length]);

  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const av = a[sort];
        const bv = b[sort];
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        // Low scores are bad; high metric values are bad.
        return sort === "performanceScore" ? av - bv : bv - av;
      }),
    [rows, sort],
  );

  const visible = sorted.slice(offset, offset + pageSize);

  const header = (key: CwvSortKey, label: string) => (
    <th
      className={`gsc-th-num gsc-th-sortable${sort === key ? " gsc-th-active" : ""}`}
      style={{ width: 78 }}
      onClick={() => setSort(key)}
      role="button"
      aria-label={`Sort by ${label}`}
    >
      {label}
      {sort === key && <span className="gsc-sort-caret">{key === "performanceScore" ? "▲" : "▼"}</span>}
    </th>
  );

  return (
    <>
      <div className="gsc-table-wrap">
        <table className="gsc-metric-table">
          <thead>
            <tr>
              <th>URL</th>
              {header("performanceScore", "Score")}
              {header("lcpMs", "LCP")}
              {header("inpMs", "INP")}
              {header("cls", "CLS")}
              {header("fcpMs", "FCP")}
              {header("ttfbMs", "TTFB")}
              <th className="gsc-th-num" style={{ width: 92 }}>Overall</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={`${r.url}|${r.strategy}`}>
                <td className="gsc-cell-label">
                  <a href={r.url} target="_blank" rel="noreferrer noopener" title={r.url}>
                    {r.url}
                  </a>
                  {r.source === "lab" && (
                    <span className="gsc-sub-note">lab data — Google has no field sample for this URL</span>
                  )}
                </td>
                <CwvCell
                  grade={gradeScore(r.performanceScore)}
                  text={r.performanceScore === null ? "—" : String(r.performanceScore)}
                />
                <CwvCell grade={gradeCwv("lcp", r.lcpMs)} text={fmtMs(r.lcpMs)} />
                <CwvCell grade={gradeCwv("inp", r.inpMs)} text={fmtMs(r.inpMs)} />
                <CwvCell grade={gradeCwv("cls", r.cls)} text={r.cls === null ? "—" : r.cls.toFixed(2)} />
                <CwvCell grade={null} text={fmtMs(r.fcpMs)} />
                <CwvCell grade={null} text={fmtMs(r.ttfbMs)} />
                <CwvCell grade={gradeOverall(r.overall)} text={r.overall ? r.overall.toLowerCase() : "—"} />
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 0 && (
          <Pagination
            total={rows.length}
            offset={offset}
            pageSize={pageSize}
            noun="URL"
            plural="URLs"
            onChange={(next) => {
              setOffset(next.offset);
              setPageSize(next.pageSize);
            }}
          />
        )}
      </div>
      <p className="muted small gsc-cwv-legend">
        <span className="cwv-chip cwv-chip-good">good</span> LCP ≤ 2.5 s · INP ≤ 200 ms · CLS ≤ 0.10
        <span className="cwv-chip cwv-chip-ni">needs work</span> LCP ≤ 4 s · INP ≤ 500 ms · CLS ≤ 0.25
        <span className="cwv-chip cwv-chip-poor">poor</span> beyond that — Google&rsquo;s thresholds
      </p>
    </>
  );
}

/** Core Web Vitals per URL, from PageSpeed Insights (field first, lab fallback). */
function VitalsTab({ websiteId }: { websiteId: string }) {
  const [data, setData] = useState<WebVitalsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<WebVitalsRunResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getWebVitals(websiteId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(errText(err, "Failed to load Core Web Vitals."));
      })
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [websiteId]);

  async function runCheck() {
    setRunning(true);
    setError(null);
    try {
      const result = await runWebVitals(websiteId, { limit: 2000 });
      setRun(result);
      setData(await getWebVitals(websiteId));
    } catch (err) {
      setError(errText(err, "Vitals check failed."));
    } finally {
      setRunning(false);
    }
  }

  const rows = data?.rows ?? [];

  return (
    <div className="gsc-overview">
      <div className="gsc-tab-head">
        <p className="muted small gsc-source-note">
          Field data from Chrome UX Report via PageSpeed Insights; lab fallback where Google has no field data.
        </p>
        <button type="button" className="btn btn-primary btn-sm" disabled={running} onClick={runCheck}>
          {running ? (
            <>
              <SpinnerIcon /> Testing&hellip;
            </>
          ) : (
            "Run check (top)"
          )}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {run && (
        <div className="opt-run-summary">
          <p className="small">
            Tested <strong>{run.tested}</strong> URL{run.tested === 1 ? "" : "s"}
            {run.failed > 0 && (
              <>
                {" "}
                · <strong>{run.failed}</strong> failed
              </>
            )}
          </p>
          {run.stoppedReason && <p className="small opt-warning">{run.stoppedReason}</p>}
        </div>
      )}

      {loading && <p className="muted small">Loading&hellip;</p>}

      {!loading && !error && rows.length === 0 && (
        <p className="muted small">
          No vitals measured yet. Hit <strong>Run check</strong> — this data comes from PageSpeed Insights, not a
          Search Console sync.
        </p>
      )}

      {rows.length > 0 && (
        <div>
          <div className="panel-summary">
            <span className="muted small">
              {rows.length.toLocaleString()} URL{rows.length === 1 ? "" : "s"} measured
              {data?.collectedAt && ` · last run ${relDate(data.collectedAt)}`}
            </span>
          </div>
          <CwvTable rows={rows} />
        </div>
      )}
    </div>
  );
}

/** Sitemap submissions as Google reports them, synced on demand. */
function SitemapsTab({ websiteId }: { websiteId: string }) {
  const [data, setData] = useState<GscSitemapsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getGscSitemaps(websiteId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(errText(err, "Failed to load sitemaps."));
      })
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [websiteId]);

  async function sync() {
    setSyncing(true);
    setError(null);
    try {
      const res = await syncGscSitemaps(websiteId);
      setLastSynced(res.synced);
      setData(await getGscSitemaps(websiteId));
    } catch (err) {
      setError(errText(err, "Sitemap sync failed."));
    } finally {
      setSyncing(false);
    }
  }

  const sitemaps = data?.sitemaps ?? [];

  return (
    <div className="gsc-overview">
      <div className="gsc-tab-head">
        <p className="muted small gsc-source-note">
          Fetched from the Search Console Sitemaps API
          {data?.fetchedAt && ` · last synced ${relDate(data.fetchedAt)}`}.
        </p>
        <button type="button" className="btn btn-primary btn-sm" disabled={syncing} onClick={sync}>
          {syncing ? (
            <>
              <SpinnerIcon /> Syncing&hellip;
            </>
          ) : (
            "Sync sitemaps"
          )}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {data && !data.gscLinked && (
        <p className="small opt-warning">
          No Search Console property linked to this site — link one on the Search Console card, then Sync.
        </p>
      )}
      {lastSynced !== null && (
        <p className="muted small">
          Synced {lastSynced.toLocaleString()} sitemap{lastSynced === 1 ? "" : "s"} from Google.
        </p>
      )}

      {loading && <p className="muted small">Loading&hellip;</p>}

      {!loading && !error && sitemaps.length === 0 && (
        <p className="muted small">
          No sitemaps stored yet. Hit <strong>Sync</strong> — the list is fetched from Search Console.
        </p>
      )}

      {sitemaps.length > 0 && (
        <div className="gsc-table-wrap">
          <table className="gsc-metric-table">
            <thead>
              <tr>
                <th>Sitemap</th>
                <th className="gsc-th-num" style={{ width: 90 }}>Submitted</th>
                <th className="gsc-th-num" style={{ width: 80 }}>Indexed</th>
                <th className="gsc-th-num" style={{ width: 70 }}>Errors</th>
                <th className="gsc-th-num" style={{ width: 82 }}>Warnings</th>
                <th style={{ width: 118 }}>Last submitted</th>
                <th style={{ width: 128 }}>Last downloaded</th>
              </tr>
            </thead>
            <tbody>
              {sitemaps.map((s) => (
                <SitemapTableRow key={s.path} row={s} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SitemapTableRow({ row }: { row: SitemapRow }) {
  const submitted = row.contents.reduce((n, c) => n + c.submitted, 0);
  const indexed = row.contents.reduce((n, c) => n + c.indexed, 0);
  return (
    <tr>
      <td className="gsc-cell-label">
        <a href={row.path} target="_blank" rel="noreferrer noopener" title={row.path}>
          {row.path}
        </a>
        {row.isSitemapsIndex && <span className="gsc-flag-chip">sitemap index</span>}
        {row.isPending && <span className="gsc-flag-chip">pending</span>}
      </td>
      <td className="gsc-cell-label">{submitted.toLocaleString()}</td>
      <td className="gsc-cell-label">
        {indexed > 0 ? (
          indexed.toLocaleString()
        ) : (
          // Google stopped reporting per-sitemap indexed counts for most
          // properties; a dash is honest where a zero would alarm.
          <span className="muted" title="Google no longer reports indexed counts for most sitemaps">
            —
          </span>
        )}
      </td>
      <td className="gsc-cell-label">
        {row.errors > 0 ? (
          <span className="gsc-badge gsc-badge-error">{row.errors.toLocaleString()}</span>
        ) : (
          <span className="muted">0</span>
        )}
      </td>
      <td className="gsc-cell-label">
        {row.warnings > 0 ? (
          <span className="gsc-badge gsc-badge-warn">{row.warnings.toLocaleString()}</span>
        ) : (
          <span className="muted">0</span>
        )}
      </td>
      <td className="muted small nowrap">{row.lastSubmitted ? relDate(row.lastSubmitted) : "—"}</td>
      <td className="muted small nowrap">{row.lastDownloaded ? relDate(row.lastDownloaded) : "—"}</td>
    </tr>
  );
}

const LINK_VIEWS = [
  { key: "pages", label: "Top linked pages", noun: "page", plural: "pages" },
  { key: "domains", label: "Outbound domains", noun: "domain", plural: "domains" },
  { key: "orphans", label: "Orphan pages", noun: "orphan page", plural: "orphan pages" },
] as const;

type LinkView = (typeof LINK_VIEWS)[number]["key"];

/**
 * The crawl link graph, server-paged -- a big site's page list would be
 * thousands of rows, so only the requested window ever crosses the wire.
 */
function LinksTab({ websiteId }: { websiteId: string }) {
  const [view, setView] = useState<LinkView>("pages");
  const [data, setData] = useState<SiteLinksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(ROW_LIMIT);
  const [nonce, setNonce] = useState(0);

  // Switching views changes the row universe -- page 5 of "pages" points at
  // nothing meaningful in "domains".
  useEffect(() => setOffset(0), [view, websiteId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSiteLinks(websiteId, { view, limit: pageSize, offset })
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(errText(err, "Failed to load link data."));
      })
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [websiteId, view, offset, pageSize, nonce]);

  const meta = LINK_VIEWS.find((v) => v.key === view) ?? LINK_VIEWS[0];
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="gsc-overview">
      <div className="gsc-tab-head">
        <div className="gsc-seg" role="group" aria-label="Link views">
          {LINK_VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              className={`gsc-seg-btn${view === v.key ? " gsc-seg-active" : ""}`}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>
        {error && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNonce((n) => n + 1)}>
            Retry
          </button>
        )}
      </div>
      <p className="muted small gsc-source-note">
        From the latest crawl&rsquo;s link graph — Google Search Console does not expose links via API.
      </p>

      {error && <p className="error-text">{error}</p>}
      {loading && <p className="muted small">Loading&hellip;</p>}

      {!loading && !error && total === 0 && (
        <p className="muted small">
          {view === "orphans"
            ? "No orphan pages found — or no completed crawl yet. Run a crawl to build the link graph."
            : "Nothing here yet. Run a crawl — this view is built from crawl data and needs no Search Console link."}
        </p>
      )}

      {total > 0 && (
        <div className="gsc-table-wrap">
          <table className="gsc-metric-table">
            <thead>
              {view === "pages" && (
                <tr>
                  <th>URL</th>
                  <th style={{ width: "26%" }}>Title</th>
                  <th className="gsc-th-num" style={{ width: 108 }}>Inbound links</th>
                  <th className="gsc-th-num" style={{ width: 70 }}>Depth</th>
                </tr>
              )}
              {view === "domains" && (
                <tr>
                  <th>Domain</th>
                  <th className="gsc-th-num">Links</th>
                  <th className="gsc-th-num" style={{ width: 110 }}>Source pages</th>
                </tr>
              )}
              {view === "orphans" && (
                <tr>
                  <th>URL</th>
                  <th style={{ width: "30%" }}>Title</th>
                  <th className="gsc-th-num" style={{ width: 70 }}>Depth</th>
                </tr>
              )}
            </thead>
            <tbody>
              {view === "pages" &&
                (rows as LinkPageRow[]).map((r) => (
                  <tr key={r.url}>
                    <td className="gsc-cell-label">
                      <a href={r.url} target="_blank" rel="noreferrer noopener" title={r.url}>
                        {r.url}
                      </a>
                    </td>
                    <td className="gsc-cell-label" title={r.title ?? ""}>
                      {r.title ?? <span className="muted">—</span>}
                    </td>
                    <td className="gsc-cell-label">{r.inboundLinks.toLocaleString()}</td>
                    <td className="gsc-cell-label">{r.depth ?? "—"}</td>
                  </tr>
                ))}
              {view === "domains" &&
                (rows as LinkDomainRow[]).map((r) => (
                  <tr key={r.domain}>
                    <td className="gsc-cell-label" title={r.domain}>
                      {r.domain}
                    </td>
                    <td className="gsc-cell-label">{r.links.toLocaleString()}</td>
                    <td className="gsc-cell-label">{r.sourcePages.toLocaleString()}</td>
                  </tr>
                ))}
              {view === "orphans" &&
                (rows as OrphanRow[]).map((r) => (
                  <tr key={r.url}>
                    <td className="gsc-cell-label">
                      <a href={r.url} target="_blank" rel="noreferrer noopener" title={r.url}>
                        {r.url}
                      </a>
                    </td>
                    <td className="gsc-cell-label" title={r.title ?? ""}>
                      {r.title ?? <span className="muted">—</span>}
                    </td>
                    <td className="gsc-cell-label">{r.depth ?? "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <Pagination
            total={total}
            offset={data?.offset ?? offset}
            pageSize={pageSize}
            busy={loading}
            noun={meta.noun}
            plural={meta.plural}
            onChange={(next) => {
              setOffset(next.offset);
              setPageSize(next.pageSize);
            }}
          />
        </div>
      )}
    </div>
  );
}

/** Structured-data coverage, aggregated from crawled JSON-LD by schema type. */
function EnhancementsTab({ websiteId, searchAppearances, searchType }: { websiteId: string; searchAppearances: GscBreakdownRow[]; searchType: "web" | "image" }) {
  const [data, setData] = useState<EnhancementsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(ROW_LIMIT);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getGscEnhancements(websiteId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(errText(err, "Failed to load structured data."));
      })
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [websiteId, nonce]);

  const types = data?.types ?? [];
  const pct = data && data.totalPages > 0 ? Math.round((data.pagesWithData / data.totalPages) * 100) : 0;

  return (
    <div className="gsc-overview">
      <div className="gsc-tab-head">
        <p className="muted small gsc-source-note">
          Structured data parsed from the latest crawl&rsquo;s JSON-LD — Google exposes no enhancements API.
        </p>
        {error && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNonce((n) => n + 1)}>
            Retry
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p className="muted small">Loading&hellip;</p>}

      {data && !loading && (
        <>
          <div className="gsc-tab-head">
            <p className="muted small gsc-source-note">Google Search Console rich-result appearances in {searchType === "image" ? "Image search" : "Web search"}.</p>
          </div>
          {searchAppearances.length === 0 ? (
            <p className="muted small">Google has not reported any search appearances for this date range yet.</p>
          ) : (
            <MetricTable
              head="Search appearance"
              rows={searchAppearances.map((row) => ({ key: row.keyValue, label: row.keyValue, ...row }))}
            />
          )}
          <div className="gsc-stat-cards">
            <StatCard value={data.totalPages.toLocaleString()} label="Crawled pages" />
            <StatCard
              value={data.pagesWithData.toLocaleString()}
              label="With structured data"
              sub={data.totalPages > 0 ? `${pct}% coverage` : undefined}
              tone={data.pagesWithData > 0 ? "good" : undefined}
            />
            <StatCard
              value={data.pagesWithNone.toLocaleString()}
              label="Without structured data"
              tone={data.pagesWithNone > 0 && data.totalPages > 0 ? "warn" : undefined}
            />
          </div>

          {data.totalPages === 0 && (
            <p className="muted small">
              No crawl data yet. Run a crawl — enhancements are read from each page&rsquo;s structured data, not
              Search Console.
            </p>
          )}
          {data.totalPages > 0 && types.length === 0 && (
            <p className="muted small">No structured data found on any crawled page.</p>
          )}

          {types.length > 0 && (
            <div>
              <h4 className="gsc-mini-title">Structured data by type</h4>
              <div className="gsc-table-wrap">
                <table className="gsc-metric-table">
                  <thead>
                    <tr>
                      <th style={{ width: 180 }}>Type</th>
                      <th className="gsc-th-num" style={{ width: 80 }}>Pages</th>
                      <th className="gsc-th-num" style={{ width: 80 }}>Items</th>
                      <th>Sample URLs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {types.slice(offset, offset + pageSize).map((t) => (
                      <tr key={t.type}>
                        <td className="gsc-cell-label" title={t.type}>
                          <strong>{t.type}</strong>
                        </td>
                        <td className="gsc-cell-label">{t.pages.toLocaleString()}</td>
                        <td className="gsc-cell-label">{t.items.toLocaleString()}</td>
                        <td className="gsc-cell-label">
                          {t.sampleUrls.map((u) => (
                            <a
                              key={u}
                              className="gsc-sample-link"
                              href={u}
                              target="_blank"
                              rel="noreferrer noopener"
                              title={u}
                            >
                              {u}
                            </a>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Pagination
                  total={types.length}
                  offset={offset}
                  pageSize={pageSize}
                  noun="type"
                  onChange={(next) => {
                    setOffset(next.offset);
                    setPageSize(next.pageSize);
                  }}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Viewport coverage from the crawl plus mobile-strategy vitals. */
function MobileTab({ websiteId }: { websiteId: string }) {
  const [data, setData] = useState<MobileUsabilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(ROW_LIMIT);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getMobileUsability(websiteId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(errText(err, "Failed to load mobile usability data."));
      })
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [websiteId, nonce]);

  const viewportPct = data && data.totalPages > 0 ? Math.round((data.withViewport / data.totalPages) * 100) : 0;
  const missing = data?.missingViewportRows ?? [];

  return (
    <div className="gsc-overview">
      <div className="gsc-tab-head">
        <p className="muted small gsc-source-note">
          Google retired the Mobile Usability API (Dec 2023) — viewport coverage comes from the crawl, vitals from
          PageSpeed Insights field data.
        </p>
        {error && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNonce((n) => n + 1)}>
            Retry
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p className="muted small">Loading&hellip;</p>}

      {data && !loading && (
        <>
          <div className="gsc-stat-cards">
            <StatCard value={data.totalPages.toLocaleString()} label="Crawled pages" />
            <StatCard
              value={data.withViewport.toLocaleString()}
              label="With viewport meta"
              sub={data.totalPages > 0 ? `${viewportPct}% of pages` : undefined}
              tone={data.totalPages > 0 && data.missingViewport === 0 ? "good" : undefined}
            />
            <StatCard
              value={data.missingViewport.toLocaleString()}
              label="Missing viewport"
              sub={data.totalPages > 0 ? `${100 - viewportPct}% of pages` : undefined}
              tone={data.missingViewport > 0 ? "bad" : data.totalPages > 0 ? "good" : undefined}
            />
          </div>

          {data.totalPages === 0 && (
            <p className="muted small">No crawl data yet. Run a crawl to measure mobile viewport coverage.</p>
          )}

          {missing.length > 0 && (
            <div>
              <h4 className="gsc-mini-title">Pages missing a viewport meta tag</h4>
              <div className="gsc-table-wrap">
                <table className="gsc-metric-table">
                  <thead>
                    <tr>
                      <th>URL</th>
                      <th style={{ width: "34%" }}>Title</th>
                    </tr>
                  </thead>
                  <tbody>
                    {missing.slice(offset, offset + pageSize).map((r) => (
                      <tr key={r.url}>
                        <td className="gsc-cell-label">
                          <a href={r.url} target="_blank" rel="noreferrer noopener" title={r.url}>
                            {r.url}
                          </a>
                        </td>
                        <td className="gsc-cell-label" title={r.title ?? ""}>
                          {r.title ?? <span className="muted">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Pagination
                  total={missing.length}
                  offset={offset}
                  pageSize={pageSize}
                  noun="page"
                  onChange={(next) => {
                    setOffset(next.offset);
                    setPageSize(next.pageSize);
                  }}
                />
              </div>
              {data.missingViewport > missing.length && (
                <p className="muted small">
                  Showing the first {missing.length.toLocaleString()} of {data.missingViewport.toLocaleString()}.
                </p>
              )}
            </div>
          )}

          {data.totalPages > 0 && (
            <div>
              <h4 className="gsc-mini-title">Mobile Core Web Vitals</h4>
              {data.cwv.length === 0 ? (
                <p className="muted small">
                  No mobile vitals yet — run a check on the <strong>Core Web Vitals</strong> tab; that data comes
                  from PageSpeed Insights.
                </p>
              ) : (
                <CwvTable rows={data.cwv} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Safe Browsing verdict plus deep links to the GSC-only surfaces. */
function SecurityTab({ websiteId }: { websiteId: string }) {
  const [data, setData] = useState<SecurityStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSecurityStatus(websiteId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(errText(err, "Failed to load security status."));
      })
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [websiteId]);

  async function check() {
    setChecking(true);
    setError(null);
    try {
      setData(await runSecurityCheck(websiteId));
    } catch (err) {
      setError(errText(err, "Safe Browsing check failed."));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="gsc-overview">
      <div className="gsc-tab-head">
        <p className="muted small gsc-source-note">
          Malware and phishing via Google Safe Browsing; manual actions are not exposed by any API — use the Search
          Console links below.
        </p>
        <button type="button" className="btn btn-primary btn-sm" disabled={checking} onClick={check}>
          {checking ? (
            <>
              <SpinnerIcon /> Checking&hellip;
            </>
          ) : (
            "Run Safe Browsing check"
          )}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p className="muted small">Loading&hellip;</p>}

      {data && !loading && (
        <>
          <div className={`gsc-sec-hero gsc-sec-${data.status}`}>
            <span className="gsc-sec-status">
              {data.status === "clean" && "No threats detected"}
              {data.status === "flagged" &&
                `${data.threats.length.toLocaleString()} threat${data.threats.length === 1 ? "" : "s"} flagged`}
              {data.status === "unavailable" && "Automated check unavailable"}
            </span>
            <span className="gsc-sec-sub">
              {data.status === "unavailable"
                ? "Set GOOGLE_API_KEY on the server to enable Google Safe Browsing checks — without a key there is no automated scan."
                : data.checkedAt
                  ? `Google Safe Browsing · last checked ${relDate(data.checkedAt)}`
                  : "Never checked — hit Run Safe Browsing check."}
            </span>
          </div>

          {data.status === "flagged" && data.threats.length > 0 && (
            <div className="gsc-table-wrap">
              <table className="gsc-metric-table">
                <thead>
                  <tr>
                    <th style={{ width: 220 }}>Threat type</th>
                    <th>URL</th>
                  </tr>
                </thead>
                <tbody>
                  {data.threats.map((t) => (
                    <tr key={`${t.threatType}|${t.url}`}>
                      <td className="gsc-cell-label">
                        <span className="gsc-verdict-chip gsc-verdict-fail">
                          {t.threatType.replace(/_/g, " ").toLowerCase()}
                        </span>
                      </td>
                      {/* Deliberately not a link -- these URLs are flagged as
                          hostile, so they render as text only. */}
                      <td className="gsc-cell-label">
                        <span title={t.url}>{t.url}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div>
            <h4 className="gsc-mini-title">Check in Search Console</h4>
            <div className="gsc-sec-links">
              <a
                className="gsc-link-card"
                href={data.gscLinks.manualActions}
                target="_blank"
                rel="noreferrer noopener"
              >
                <span className="gsc-link-card-title">Manual actions ↗</span>
                <span className="gsc-link-card-sub">
                  Google reports manual actions only in its own UI — no API exists. Opens Search Console; pick this
                  property there.
                </span>
              </a>
              <a
                className="gsc-link-card"
                href={data.gscLinks.securityIssues}
                target="_blank"
                rel="noreferrer noopener"
              >
                <span className="gsc-link-card-title">Security issues ↗</span>
                <span className="gsc-link-card-sub">
                  Hacked-content and social-engineering flags, exactly as Google shows them to searchers.
                </span>
              </a>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Google's "Why pages aren't indexed" report, rebuilt.
 *
 * Google splits that report by Source: "Website" reasons are conditions our
 * own crawl can see (a noindex tag, a redirect, a 403), while "Google systems"
 * reasons are judgements only Google makes. There is no bulk coverage API, so
 * the Website rows are computed from the latest crawl and the Google rows come
 * from stored URL Inspection results.
 *
 * The reasons deliberately have no total. They are independent predicates, so
 * one page can match several -- a noindex post that is also a duplicate counts
 * twice. Google assigns exactly one reason per URL and we cannot, so a summed
 * column would read as authoritative while being wrong.
 */
function CoverageTab({ websiteId }: { websiteId: string }) {
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCoverage(websiteId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(errText(err, "Failed to load index coverage."));
      })
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [websiteId, nonce]);

  const website = data?.reasons ?? [];
  const google = data?.googleReasons ?? [];
  // Zero-count rows are kept so the table reads as a full checklist rather
  // than an arbitrary subset; this counts only the ones actually biting.
  const affected = website.filter((r) => r.pages > 0).length;

  return (
    <div className="gsc-overview">
      <div className="gsc-tab-head">
        <p className="muted small gsc-source-note">
          Google publishes no bulk coverage API. The <strong>Website</strong> reasons below are computed from the
          latest crawl; the <strong>Google systems</strong> reasons need a URL Inspection run.
        </p>
        {error && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNonce((n) => n + 1)}>
            Retry
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p className="muted small">Loading&hellip;</p>}

      {data && !loading && data.crawlId === null && (
        <p className="muted small">
          No completed crawl yet. Run a crawl &mdash; these reasons are worked out from your own pages, not from
          Search Console.
        </p>
      )}

      {data && !loading && data.crawlId !== null && (
        <>
          <div className="gsc-stat-cards">
            <StatCard value={data.totalCrawled.toLocaleString()} label="Pages crawled" />
            <StatCard
              value={data.indexableCount.toLocaleString()}
              label="Fully indexable"
              sub={
                data.totalCrawled > 0
                  ? `${Math.round((data.indexableCount / data.totalCrawled) * 100)}% of crawled`
                  : undefined
              }
              tone={data.indexableCount > 0 ? "good" : undefined}
            />
            <StatCard
              value={affected.toLocaleString()}
              label="Reasons affecting pages"
              sub={`of ${website.length} checked`}
              tone={affected > 0 ? "warn" : undefined}
            />
            <StatCard
              value={data.inspectionsAvailable.toLocaleString()}
              label="Pages inspected by Google"
              tone={data.inspectionsAvailable === 0 ? "bad" : "good"}
            />
          </div>

          {data.crawledAt && <p className="muted small">From the crawl finished {relDate(data.crawledAt)}.</p>}

          <h4 className="gsc-mini-title">Why pages aren&rsquo;t indexed</h4>
          <p className="muted small gsc-coverage-note">
            One page can appear under more than one reason, so these numbers are a per-reason breakdown and are not
            meant to be added up. Click a row for example URLs.
          </p>

          <div className="gsc-table-wrap">
            <table className="gsc-metric-table gsc-coverage-table">
              <thead>
                <tr>
                  <th>Reason</th>
                  <th style={{ width: 130 }}>Source</th>
                  <th className="gsc-th-num" style={{ width: 110 }}>Pages</th>
                </tr>
              </thead>
              <tbody>
                {[...website, ...google].map((r) => (
                  <CoverageRow
                    key={r.reason}
                    row={r}
                    expanded={open === r.reason}
                    onToggle={() => setOpen(open === r.reason ? null : r.reason)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {data.inspectionsAvailable === 0 && (
            <p className="small opt-warning">
              The three <strong>Google systems</strong> reasons show &ldquo;needs inspection&rdquo; rather than zero,
              because no URLs have been inspected yet &mdash; a zero there would read as &ldquo;no problem&rdquo;
              when it actually means &ldquo;not asked&rdquo;. Run <strong>Check All</strong> on the Indexing tab to
              fill them in. Google allows 2,000 URL inspections per property per day.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** One reason row; expands to show the sample URLs behind the count. */
function CoverageRow({
  row,
  expanded,
  onToggle,
}: {
  row: CoverageReasonRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const clickable = row.sampleUrls.length > 0;
  const tone = !row.available ? "muted" : row.pages > 0 ? "warn" : "good";

  return (
    <>
      <tr className={clickable ? "gsc-coverage-row" : undefined} onClick={clickable ? onToggle : undefined}>
        <td className="gsc-cell-label">
          <span className="gsc-coverage-reason">
            {clickable && <span className="gsc-coverage-caret">{expanded ? "−" : "+"}</span>}
            <strong>{row.reason}</strong>
          </span>
          <span className="gsc-coverage-detail">{row.detail}</span>
        </td>
        <td className="gsc-cell-label">
          <span className={`gsc-source-chip gsc-source-chip-${row.source === "Website" ? "site" : "google"}`}>
            {row.source}
          </span>
        </td>
        <td className="gsc-cell-label">
          {row.available ? (
            <span className={`gsc-coverage-count gsc-coverage-count-${tone}`}>{row.pages.toLocaleString()}</span>
          ) : (
            <span className="muted small gsc-coverage-pending">needs inspection</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="gsc-coverage-samples">
          <td colSpan={3}>
            <span className="muted small">Example pages:</span>
            {row.sampleUrls.map((u) => (
              <a key={u} className="gsc-sample-link" href={u} target="_blank" rel="noreferrer noopener" title={u}>
                {u}
              </a>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

function TargetedCrawlResults({ crawlId, urlsQueued }: { crawlId: string; urlsQueued: number }) {
  const [crawl, setCrawl] = useState<Crawl | null>(null);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [optimizations, setOptimizations] = useState<Optimization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedUrl, setExpandedUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let interval: ReturnType<typeof setInterval>;

    async function poll() {
      try {
        const { crawl: current } = await getCrawl(crawlId);
        if (!active) return;
        setCrawl(current);

        if (current.status === "COMPLETED" || current.status === "FAILED" || current.status === "CANCELLED") {
          clearInterval(interval);

          // Fetch results
          const [pagesRes, issuesRes, optRes] = await Promise.all([
            getCrawlPages(crawlId, { limit: 100 }),
            getCrawlIssues(crawlId, { limit: 1000 }),
            getCrawlOptimizations(crawlId, { limit: 1000 }),
          ]);

          if (!active) return;
          setPages(pagesRes.pages);
          setIssues(issuesRes.issues);
          setOptimizations(optRes.optimizations);
          setLoading(false);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Failed to load crawl status.");
      }
    }

    poll();
    interval = setInterval(poll, 2000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [crawlId]);

  if (error) {
    return (
      <div className="opt-run-summary">
        <p className="error-text small">Failed to monitor targeted crawl: {error}</p>
      </div>
    );
  }

  if (!crawl || crawl.status === "QUEUED" || crawl.status === "RUNNING") {
    const pct = crawl && crawl.stats.discovered > 0
      ? Math.min(100, Math.round((crawl.stats.processed / crawl.stats.discovered) * 100))
      : 0;

    return (
      <div className="opt-run-summary">
        <p className="small">
          Targeted crawl running for <strong>{urlsQueued.toLocaleString()}</strong> URL{urlsQueued === 1 ? "" : "s"}.
          {" "}
          <a href={`/site/${crawlId}`} className="gsc-detail-link" target="_blank" rel="noreferrer">
            View full progress
          </a>
        </p>
        <div className="progress-cell" style={{ marginTop: '8px' }}>
          <div className="progress-bar">
            <div className="progress-bar-fill progress-bar-fill-running" style={{ width: `${pct}%` }} />
          </div>
          <span className="muted small progress-count">
            {crawl ? `${crawl.stats.processed}/${crawl.stats.discovered}` : "Starting..."}
          </span>
        </div>
      </div>
    );
  }

  if (pages.length === 0) {
    return (
      <div className="opt-run-summary">
        <p className="small">
          Targeted crawl finished, but no pages were processed successfully.
        </p>
      </div>
    );
  }

  return (
    <div className="opt-run-summary">
      <p className="small">
        Targeted crawl completed for <strong>{pages.length.toLocaleString()}</strong> URL{pages.length === 1 ? "" : "s"}.
        {" "}
        <a href={`/site/${crawlId}`} className="gsc-detail-link" target="_blank" rel="noreferrer">
          Open in Site View
        </a>
      </p>

      <div className="gsc-table-wrap" style={{ marginTop: '16px' }}>
        <table className="gsc-metric-table">
          <thead>
            <tr>
              <th>Crawled URL</th>
              <th className="gsc-th-num" style={{ width: 80 }}>Issues</th>
              <th className="gsc-th-num" style={{ width: 80 }}>Fixes</th>
              <th style={{ width: 100 }}></th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p) => {
              const pageIssues = issues.filter((i) => i.pageId === p.id);
              const pageFixes = optimizations.filter((o) => o.pageId === p.id);
              const isExpanded = expandedUrl === p.url;

              return (
                <Fragment key={p.id}>
                  <tr>
                    <td className="gsc-cell-label">
                      <a href={p.url} target="_blank" rel="noreferrer noopener" title={p.url}>
                        {p.url}
                      </a>
                    </td>
                    <td className="gsc-td-num">
                      {pageIssues.length > 0 ? (
                        <span className="stat-chip stat-chip-danger">{pageIssues.length}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="gsc-td-num">
                      {pageFixes.length > 0 ? (
                        <span className="stat-chip stat-chip-accent">{pageFixes.length}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {(pageIssues.length > 0 || pageFixes.length > 0) && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setExpandedUrl(isExpanded ? null : p.url)}
                        >
                          {isExpanded ? "Hide" : "View"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {isExpanded && (pageIssues.length > 0 || pageFixes.length > 0) && (
                    <tr className="gsc-detail-row">
                      <td colSpan={4} style={{ padding: 0 }}>
                        <div style={{ padding: '16px', background: 'var(--bg-inset)', borderBottom: '1px solid var(--border)' }}>
                          {pageIssues.length > 0 && (
                            <div style={{ marginBottom: pageFixes.length > 0 ? '16px' : 0 }}>
                              <h5 style={{ margin: '0 0 8px 0', fontSize: '13px' }}>Found Issues</h5>
                              <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px' }}>
                                {pageIssues.map(issue => (
                                  <li key={issue.id} style={{ marginBottom: '4px' }}>
                                    <strong style={{ color: issue.severity === 'critical' ? 'var(--red-500)' : 'var(--orange-500)' }}>
                                      {issue.type.replace(/_/g, " ")}:
                                    </strong>{" "}
                                    {issue.message}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {pageFixes.length > 0 && (
                            <div>
                              <h5 style={{ margin: '0 0 8px 0', fontSize: '13px' }}>Suggested Fixes</h5>
                              <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px' }}>
                                {pageFixes.map(fix => (
                                  <li key={fix.id} style={{ marginBottom: '4px' }}>
                                    <strong style={{ color: 'var(--blue-500)' }}>{fix.action.replace(/_/g, " ")}:</strong>{" "}
                                    {fix.newValue}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
