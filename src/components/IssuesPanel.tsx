import { useEffect, useMemo, useState } from "react";
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

/** Turns "title.too_long" into "Title too long". */
function humanType(type: string) {
  const [, ...rest] = type.split(".");
  const tail = rest.join(" ").replace(/_/g, " ");
  const head = type.split(".")[0];
  return `${head.charAt(0).toUpperCase()}${head.slice(1)} — ${tail}`;
}

export function IssuesPanel({ crawlId }: { crawlId: string }) {
  const [data, setData] = useState<{ issues: Issue[]; byType: IssueTypeSummary[]; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [severityFilter, setSeverityFilter] = useState<IssueSeverity | "all">("all");
  const [openType, setOpenType] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await getCrawlIssues(crawlId);
      setData({ issues: res.issues, byType: res.byType, truncated: res.truncated });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load issues.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    getCrawlIssues(crawlId)
      .then((res) => {
        if (!cancelled) setData({ issues: res.issues, byType: res.byType, truncated: res.truncated });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load issues.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [crawlId]);

  async function handleReanalyze() {
    setReanalyzing(true);
    try {
      await analyzeCrawl(crawlId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed.");
    } finally {
      setReanalyzing(false);
    }
  }

  const counts = useMemo(() => {
    const c: Record<IssueSeverity, number> = { critical: 0, warning: 0, notice: 0 };
    for (const t of data?.byType ?? []) c[t.severity] += t.count;
    return c;
  }, [data]);

  const total = counts.critical + counts.warning + counts.notice;

  const visibleTypes = useMemo(() => {
    const types = data?.byType ?? [];
    const filtered = severityFilter === "all" ? types : types.filter((t) => t.severity === severityFilter);
    // Critical first, then by how many pages are affected.
    return [...filtered].sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.count - a.count,
    );
  }, [data, severityFilter]);

  const issuesForType = useMemo(() => {
    if (!openType || !data) return [];
    return data.issues.filter((i) => i.type === openType);
  }, [openType, data]);

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
            <span className="sev-count">{counts[sev]}</span>
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

      {data?.truncated && (
        <p className="muted small">Showing the first 2,000 issues; totals above cover the full crawl.</p>
      )}

      <ul className="issue-type-list">
        {visibleTypes.map((t) => {
          const open = openType === t.type;
          return (
            <li key={t.type} className="issue-type">
              <button type="button" className="issue-type-head" onClick={() => setOpenType(open ? null : t.type)}>
                <span className={`sev-dot sev-dot-${t.severity}`} />
                <span className="issue-type-name">{humanType(t.type)}</span>
                {t.autoFixable && <span className="flag-chip auto-fix-chip">auto-fixable</span>}
                <span className={`risk-chip risk-${t.risk}`}>{t.risk} risk</span>
                <span className="issue-type-count">{t.count}</span>
                <span className="pages-expand-chevron">{open ? "−" : "+"}</span>
              </button>

              {open && (
                <ul className="issue-instances">
                  {issuesForType.slice(0, 50).map((i) => (
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
                  {issuesForType.length > 50 && (
                    <li className="muted small">+{issuesForType.length - 50} more affected pages</li>
                  )}
                  {issuesForType.length === 0 && (
                    <li className="muted small">
                      Instances not loaded (beyond the 2,000-issue fetch limit).
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
