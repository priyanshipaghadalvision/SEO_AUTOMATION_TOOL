import { useEffect, useMemo, useState } from "react";
import type {
  GscBreakdownRow,
  GscInspection,
  GscInspectionRunResult,
  GscMetricsResponse,
  GscPageMetric,
  GscVerdict,
} from "../api/client";
import { getGscMetrics, inspectGscUrls } from "../api/client";
import { DateRangePicker } from "./DateRangePicker";
import type { Range } from "./DateRangePicker";
import { SpinnerIcon } from "./icons";
import "./GscDataModal.css";

type Tab = "overview" | "indexing" | "pages" | "queries" | "segments";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "indexing", label: "Indexing" },
  { key: "pages", label: "Pages" },
  { key: "queries", label: "Queries" },
  { key: "segments", label: "Devices & Countries" },
];

const VERDICT_LABEL: Record<GscVerdict, string> = {
  PASS: "Indexed",
  PARTIAL: "Indexed with issues",
  FAIL: "Not indexed",
  NEUTRAL: "Excluded",
  VERDICT_UNSPECIFIED: "Unknown",
};

/** Rows rendered per table. Enough to scroll; short of freezing the DOM. */
const ROW_LIMIT = 250;

export function GscDataModal({
  websiteId,
  domain,
  onClose,
}: {
  websiteId: string;
  domain: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<GscMetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [search, setSearch] = useState("");
  // null until the first response tells us what Google's newest settled day
  // is -- guessing it client-side would drift from the server's clamp.
  const [range, setRange] = useState<Range | null>(null);
  const [rangeBusy, setRangeBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // A range change may need a live Google fetch, so the whole panel shows a
    // busy state rather than leaving stale numbers under a new date label.
    if (range) setRangeBusy(true);
    setError(null);

    getGscMetrics(websiteId, range ? { start: range.start, end: range.end } : undefined)
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
  }, [websiteId, range?.start, range?.end]);

  /** Re-reads everything after an inspection batch adds rows. */
  async function reload() {
    setData(await getGscMetrics(websiteId, range ? { start: range.start, end: range.end } : undefined));
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Clearing the filter when switching tabs avoids the confusing state where
  // a tab looks empty because a term typed on a different tab still applies.
  useEffect(() => setSearch(""), [tab]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Search Console data for ${domain}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h3>Search Console</h3>
            <p className="muted small">
              {data?.property.siteUrl ?? domain}
              {data?.totals?.firstDate && ` · ${data.totals.firstDate} to ${data.totals.lastDate}`}
            </p>
          </div>
          <div className="gsc-header-right">
            {data && (
              <DateRangePicker
                value={range ?? { start: data.range.startDate, end: data.range.endDate }}
                latestAvailable={data.range.latestAvailable}
                busy={rangeBusy}
                onChange={setRange}
              />
            )}
            <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
              &times;
            </button>
          </div>
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

        <div className="modal-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`modal-tab${tab === t.key ? " modal-tab-active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {loading && <p className="muted small">Loading Search Console data&hellip;</p>}
          {rangeBusy && !loading && (
            <p className="muted small">Loading {range?.start} to {range?.end}&hellip;</p>
          )}
          {error && <p className="error-text">{error}</p>}

          {data && !loading && !data.totals?.impressions && tab !== "indexing" && (
            <p className="muted small">
              No data stored yet for this property. Close this and hit <strong>Sync</strong> on the Search Console
              card first.
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
        </div>
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
  const [filter, setFilter] = useState<GscVerdict | "all">("all");
  const [search, setSearch] = useState("");

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

  const byVerdict = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of data.coverage) counts[c.verdict] = (counts[c.verdict] ?? 0) + c.count;
    return counts;
  }, [data.coverage]);

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
      .filter((i) => !q || i.pageUrl.toLowerCase().includes(q) || (i.coverageState ?? "").toLowerCase().includes(q));
  }, [data.inspections, filter, search]);

  const total = data.inspections.length;

  return (
    <div className="gsc-overview">
      <div className="gsc-index-toolbar">
        <div className="gsc-verdict-cards">
          {(["PASS", "FAIL", "NEUTRAL", "PARTIAL"] as GscVerdict[]).map((v) => (
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
        <div className="gsc-index-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={running} onClick={() => inspect(1000)}>
            {running ? (
              <>
                <SpinnerIcon /> Inspecting&hellip;
              </>
            ) : (
              "Check 50 URLs"
            )}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={running} onClick={() => inspect(2000)}>
            Check All
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
        <p className="muted small">
          Nothing checked yet. Google&rsquo;s URL Inspection API tells you whether each page is actually indexed and,
          if not, the exact reason. It allows <strong>2,000 URLs per day</strong> for this property, so it runs in
          batches — highest-traffic pages first, then pages your crawler found that Google has never sent traffic to.
        </p>
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
                  <tr key={`${r.verdict}-${r.coverageState}`}>
                    <td className="gsc-cell-label" title={r.coverageState ?? ""}>{r.coverageState}</td>
                    <td className="gsc-td-num">
                      <span className={`gsc-verdict-chip gsc-verdict-${r.verdict.toLowerCase()}`}>
                        {VERDICT_LABEL[r.verdict]}
                      </span>
                    </td>
                    <td className="gsc-td-num">{r.count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {total > 0 && (
        <div>
          <div className="modal-summary">
            <span className="muted small">
              {rows.length.toLocaleString()} of {total.toLocaleString()} checked URL
              {total === 1 ? "" : "s"}
              {filter !== "all" && ` · ${VERDICT_LABEL[filter]}`}
            </span>
            <input
              type="text"
              className="modal-search"
              placeholder="Filter by URL or reason…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="gsc-table-wrap">
            <table className="gsc-metric-table gsc-index-table">
              <thead>
                <tr>
                  <th>URL</th>
                  <th style={{ width: 130 }}>Status</th>
                  <th>Reason</th>
                  <th style={{ width: 150 }}>Google&rsquo;s canonical</th>
                  <th style={{ width: 110 }}>Last crawled</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, ROW_LIMIT).map((i) => (
                  <InspectionRow key={i.pageUrl} row={i} />
                ))}
              </tbody>
            </table>
            {rows.length > ROW_LIMIT && (
              <p className="muted small gsc-truncated">
                Showing {ROW_LIMIT} of {rows.length.toLocaleString()} matching URLs.
              </p>
            )}
            {rows.length === 0 && <p className="muted small gsc-truncated">Nothing matches that filter.</p>}
          </div>
        </div>
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
      <td className="muted small nowrap">
        {row.lastCrawlTime ? new Date(row.lastCrawlTime).toLocaleDateString() : "never"}
      </td>
    </tr>
  );
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

  const sorted = useMemo(() => {
    // Position is the one metric where lower is better, so it sorts ascending
    // while everything else sorts descending.
    const dir = sort === "position" ? 1 : -1;
    return [...rows].sort((a, b) => (a[sort] - b[sort]) * dir).slice(0, ROW_LIMIT);
  }, [rows, sort]);

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
          {sorted.map((r) => (
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
              <td className="gsc-td-num">{r.clicks.toLocaleString()}</td>
              <td className="gsc-td-num">{r.impressions.toLocaleString()}</td>
              <td className="gsc-td-num">{(r.ctr * 100).toFixed(2)}%</td>
              <td className="gsc-td-num">{r.position.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > ROW_LIMIT && (
        <p className="muted small gsc-truncated">
          Showing the top {ROW_LIMIT} of {rows.length.toLocaleString()} by {sort}.
        </p>
      )}
      {rows.length === 0 && <p className="muted small gsc-truncated">Nothing matches that filter.</p>}
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
      <div className="modal-summary">
        <span className="muted small">
          {rows.length.toLocaleString()} {rows.length === 1 ? noun : plural}
          {filtering ? ` matching “${value.trim()}” of ${total.toLocaleString()}` : " with impressions"}
        </span>
        <input
          type="text"
          className="modal-search"
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
