import { useEffect, useState } from "react";
import type { MergedUrlRow, MergedUrlsResponse, UrlBucket } from "../api/client";
import { getMergedUrls } from "../api/client";
import { Pagination } from "./Pagination";
import "./Panel.css";
import "./SiteUrlsPanel.css";

/**
 * The unified URL table: crawl data and Search Console side by side.
 *
 * Buckets are the spine rather than a filter dropdown, because each one is a
 * different job. "Indexed, no clicks" is a copywriting problem; "not indexed"
 * is a technical one; "Google knows, we didn't crawl" is a discovery gap. A
 * single undifferentiated list of 10,000 URLs hides all three.
 */

const BUCKETS: Array<{ key: UrlBucket; label: string; hint: string; tone: string }> = [
  {
    key: "indexed_traffic",
    label: "Indexed + traffic",
    hint: "Working. Watch these for drops.",
    tone: "good",
  },
  {
    key: "indexed_no_clicks",
    label: "Indexed, no clicks",
    hint: "Ranking but nobody clicks — a title and description problem.",
    tone: "warn",
  },
  {
    key: "not_indexed",
    label: "Not indexed",
    hint: "Google looked and declined. The reason is in the last column.",
    tone: "bad",
  },
  {
    key: "not_crawled",
    label: "Google knows, we don't",
    hint: "Google sends traffic here but our crawler never reached it.",
    tone: "info",
  },
  {
    key: "crawled_no_data",
    label: "Crawled, no data",
    hint: "We crawled it; Google has never shown it in this date range.",
    tone: "muted",
  },
];

export function SiteUrlsPanel({
  websiteId,
  range,
}: {
  websiteId: string;
  range?: { start: string; end: string };
}) {
  const [data, setData] = useState<MergedUrlsResponse | null>(null);
  const [bucket, setBucket] = useState<UrlBucket | null>(null);
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(100);

  // Any change to what is being counted invalidates the current page number:
  // page 40 of the unfiltered list is past the end of a 12-row bucket.
  useEffect(() => setOffset(0), [websiteId, range?.start, range?.end, bucket, applied]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getMergedUrls(websiteId, {
      start: range?.start,
      end: range?.end,
      bucket: bucket ?? undefined,
      search: applied || undefined,
      limit: pageSize,
      offset,
    })
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load URLs.");
      })
      .finally(() => {
        // Never guarded by `cancelled` -- a superseded request must still
        // release the loading state, or the panel stays stuck.
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [websiteId, range?.start, range?.end, bucket, applied, offset, pageSize]);

  return (
    <div className="su-panel">
      <div className="su-buckets">
        {BUCKETS.map((b) => (
          <button
            key={b.key}
            type="button"
            title={b.hint}
            className={`su-bucket su-bucket-${b.tone}${bucket === b.key ? " su-bucket-active" : ""}`}
            onClick={() => setBucket(bucket === b.key ? null : b.key)}
          >
            <span className="su-bucket-count">{(data?.counts[b.key] ?? 0).toLocaleString()}</span>
            <span className="su-bucket-label">{b.label}</span>
          </button>
        ))}
      </div>

      {data && !data.gscLinked && (
        <p className="small opt-warning">
          No Search Console property linked to this site, so every URL falls into the crawl-only bucket. Link one on
          the Search Console card to see traffic and index status here.
        </p>
      )}

      <div className="panel-summary">
        <span className="muted small">
          {loading
            ? "Loading…"
            : `${(data?.matched ?? 0).toLocaleString()} of ${(data?.total ?? 0).toLocaleString()} URLs`}
          {bucket && ` · ${BUCKETS.find((b) => b.key === bucket)?.label}`}
        </span>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(search.trim());
          }}
        >
          <input
            type="text"
            className="panel-search"
            placeholder="Filter by URL, then Enter…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
      </div>

      {error && <p className="error-text">{error}</p>}
      {bucket && <p className="muted small su-hint">{BUCKETS.find((b) => b.key === bucket)?.hint}</p>}

      <div className="gsc-table-wrap">
        <table className="gsc-metric-table su-table">
          <thead>
            <tr>
              <th>URL</th>
              <th className="gsc-th-num">Clicks</th>
              <th className="gsc-th-num">Impr.</th>
              <th className="gsc-th-num">Pos.</th>
              <th className="gsc-th-num">Words</th>
              <th className="gsc-th-num">Issues</th>
              <th>Google&rsquo;s verdict</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((r) => (
              <UrlRow key={r.url} row={r} />
            ))}
          </tbody>
        </table>
        {!loading && data?.rows.length === 0 && (
          <p className="muted small gsc-truncated">Nothing in this bucket for the selected dates.</p>
        )}
      </div>

      {(data?.matched ?? 0) > 0 && (
        <Pagination
          total={data?.matched ?? 0}
          offset={offset}
          pageSize={pageSize}
          busy={loading}
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

function UrlRow({ row }: { row: MergedUrlRow }) {
  // A page we never crawled has no crawl-side numbers -- showing 0 words
  // would read as "empty page" rather than "not measured".
  const notCrawled = row.bucket === "not_crawled";

  return (
    <tr>
      <td className="gsc-cell-label">
        <a href={row.url} target="_blank" rel="noreferrer noopener" title={row.url}>
          {row.url}
        </a>
        {row.title && <span className="su-title">{row.title}</span>}
      </td>
      <td className="gsc-cell-label">{row.clicks.toLocaleString()}</td>
      <td className="gsc-cell-label">{row.impressions.toLocaleString()}</td>
      <td className="gsc-cell-label">{row.position === null ? "—" : row.position.toFixed(1)}</td>
      <td className="gsc-cell-label">{notCrawled ? "—" : (row.wordCount ?? "—")}</td>
      <td className="gsc-cell-label">
        {notCrawled ? "—" : row.issueCount > 0 ? <span className="su-issues">{row.issueCount}</span> : "0"}
      </td>
      <td className="gsc-cell-label" title={row.coverageState ?? ""}>
        {row.coverageState ?? <span className="muted">not checked</span>}
        {row.noindex && <span className="su-flag">noindex</span>}
        {row.httpStatus !== null && row.httpStatus >= 300 && (
          <span className="su-flag">HTTP {row.httpStatus}</span>
        )}
      </td>
    </tr>
  );
}
