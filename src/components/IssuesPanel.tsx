import { useCallback, useEffect, useMemo, useState } from "react";
import type { Issue, IssueSeverity, IssueTypeSummary } from "../api/client";
import { analyzeCrawl, getCrawlIssues } from "../api/client";
import { SpinnerIcon } from "./icons";
import { IssueEvidence } from "./IssueEvidence";

const SEVERITY_ORDER: IssueSeverity[] = ["critical", "warning", "notice"];
const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  notice: "Notice",
};

/** Instances fetched per request when a type is expanded. */
const PAGE_SIZE = 100;

/** Turns "title.too_long" into "Title — too long". */
function humanType(type: string) {
  const [, ...rest] = type.split(".");
  const tail = rest.join(" ").replace(/_/g, " ");
  const head = type.split(".")[0];
  return `${head.charAt(0).toUpperCase()}${head.slice(1)} — ${tail}`;
}

/** Instances loaded so far for one expanded issue type. */
interface TypeState {
  rows: Issue[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
}

export function IssuesPanel({ crawlId }: { crawlId: string }) {
  const [byType, setByType] = useState<IssueTypeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [severityFilter, setSeverityFilter] = useState<IssueSeverity | "all">("all");
  const [openType, setOpenType] = useState<string | null>(null);
  const [instances, setInstances] = useState<Record<string, TypeState>>({});

  /**
   * Only the rollup is loaded up front.
   *
   * The old design fetched 2,000 issues in bulk and filtered them client-side,
   * which meant any type whose instances fell outside that window could only
   * say "not loaded". Fetching per type on expand has no such ceiling: each
   * type pages independently, however many issues the crawl produced.
   */
  const loadSummary = useCallback(async () => {
    const res = await getCrawlIssues(crawlId, { limit: 1 });
    setByType(res.byType);
  }, [crawlId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCrawlIssues(crawlId, { limit: 1 })
      .then((res) => {
        if (!cancelled) setByType(res.byType);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load issues.");
      })
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [crawlId]);

  async function loadInstances(type: string, append: boolean) {
    const current = instances[type];
    const offset = append ? (current?.rows.length ?? 0) : 0;

    setInstances((prev) => ({
      ...prev,
      [type]: {
        rows: append ? (current?.rows ?? []) : [],
        total: current?.total ?? 0,
        hasMore: current?.hasMore ?? false,
        loading: true,
        error: null,
      },
    }));

    try {
      const res = await getCrawlIssues(crawlId, { type, limit: PAGE_SIZE, offset });
      setInstances((prev) => ({
        ...prev,
        [type]: {
          rows: [...(append ? (prev[type]?.rows ?? []) : []), ...res.issues],
          total: res.matched,
          hasMore: res.hasMore,
          loading: false,
          error: null,
        },
      }));
    } catch (err) {
      setInstances((prev) => ({
        ...prev,
        [type]: {
          rows: prev[type]?.rows ?? [],
          total: prev[type]?.total ?? 0,
          hasMore: false,
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load instances.",
        },
      }));
    }
  }

  function toggleType(type: string) {
    if (openType === type) {
      setOpenType(null);
      return;
    }
    setOpenType(type);
    // Cached from a previous expand -- don't re-fetch.
    if (!instances[type]) loadInstances(type, false);
  }

  async function handleReanalyze() {
    setReanalyzing(true);
    try {
      await analyzeCrawl(crawlId);
      setInstances({}); // Stale after re-analysis: issue ids are recreated.
      setOpenType(null);
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed.");
    } finally {
      setReanalyzing(false);
    }
  }

  const counts = useMemo(() => {
    const c: Record<IssueSeverity, number> = { critical: 0, warning: 0, notice: 0 };
    for (const t of byType) c[t.severity] += t.count;
    return c;
  }, [byType]);

  const total = counts.critical + counts.warning + counts.notice;

  const visibleTypes = useMemo(() => {
    const filtered = severityFilter === "all" ? byType : byType.filter((t) => t.severity === severityFilter);
    return [...filtered].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.count - a.count,
    );
  }, [byType, severityFilter]);

  if (loading) return <p className="muted small">Analysing&hellip;</p>;
  if (error) return <p className="error-text">{error}</p>;

  if (total === 0) {
    return (
      <div className="issues-empty">
        <p className="muted small">
          No issues recorded for this crawl. Crawls finished before the analysis engine existed have no findings
          until re-analysed.
        </p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={handleReanalyze} disabled={reanalyzing}>
          {reanalyzing ? (
            <>
              <SpinnerIcon /> Analysing&hellip;
            </>
          ) : (
            "Run analysis"
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="issues-panel">
      <div className="issues-summary">
        {SEVERITY_ORDER.map((sev) => (
          <button
            key={sev}
            type="button"
            className={`sev-card sev-card-${sev}${severityFilter === sev ? " sev-card-active" : ""}`}
            onClick={() => setSeverityFilter(severityFilter === sev ? "all" : sev)}
          >
            <span className="sev-count">{counts[sev].toLocaleString()}</span>
            <span className="sev-label">{SEVERITY_LABEL[sev]}</span>
          </button>
        ))}
        <button
          type="button"
          className="btn btn-ghost btn-sm issues-reanalyze"
          onClick={handleReanalyze}
          disabled={reanalyzing}
          title="Re-run the rules against the stored crawl data (no re-crawl)"
        >
          {reanalyzing ? (
            <>
              <SpinnerIcon /> Analysing&hellip;
            </>
          ) : (
            "Re-analyse"
          )}
        </button>
      </div>

      <ul className="issue-type-list">
        {visibleTypes.map((t) => {
          const open = openType === t.type;
          const state = instances[t.type];
          return (
            <li key={t.type} className="issue-type">
              <button type="button" className="issue-type-head" onClick={() => toggleType(t.type)}>
                <span className={`sev-dot sev-dot-${t.severity}`} />
                <span className="issue-type-name">{humanType(t.type)}</span>
                {t.autoFixable && <span className="flag-chip auto-fix-chip">auto-fixable</span>}
                <span className={`risk-chip risk-${t.risk}`}>{t.risk} risk</span>
                <span className="issue-type-count">{t.count.toLocaleString()}</span>
                <span className="pages-expand-chevron">{open ? "−" : "+"}</span>
              </button>

              {open && (
                <ul className="issue-instances">
                  {state?.error && <li className="error-text small">{state.error}</li>}

                  {state?.rows.map((i) => (
                    <li key={i.id}>
                      <span className="issue-msg">{i.message}</span>
                      {i.url && (
                        <a href={i.url} target="_blank" rel="noreferrer noopener" className="issue-url" title={i.url}>
                          {i.url}
                        </a>
                      )}
                      <IssueEvidence issue={i} />
                    </li>
                  ))}

                  {state?.loading && (
                    <li className="muted small">
                      <SpinnerIcon /> Loading instances&hellip;
                    </li>
                  )}

                  {state && !state.loading && (
                    <li className="issue-more">
                      <span className="muted small">
                        Showing {state.rows.length.toLocaleString()} of {state.total.toLocaleString()}
                      </span>
                      {state.hasMore && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => loadInstances(t.type, true)}
                        >
                          Load {Math.min(PAGE_SIZE, state.total - state.rows.length)} more
                        </button>
                      )}
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
