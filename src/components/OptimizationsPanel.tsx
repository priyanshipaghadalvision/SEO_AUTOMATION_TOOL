import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Optimization,
  OptimizationAction,
  OptimizationRunResult,
  OptimizationStatus,
} from "../api/client";
import { generateCrawlOptimizations, getCrawlOptimizations, setOptimizationStatus } from "../api/client";
import { SpinnerIcon } from "./icons";

/** Display order: highest-leverage, lowest-effort fixes first. */
const ACTION_ORDER: OptimizationAction[] = [
  "UPDATE_TITLE",
  "UPDATE_DESCRIPTION",
  "ADD_H1",
  "ADD_CANONICAL",
  "ADD_SCHEMA",
  "SET_IMAGE_ALT",
  "FIX_REDIRECT_CHAIN",
  "DEFER_SCRIPTS",
  "ADD_ROBOTS_TXT",
  "ADD_SITEMAP",
];

const ACTION_LABEL: Record<OptimizationAction, string> = {
  UPDATE_TITLE: "Rewrite title tag",
  UPDATE_DESCRIPTION: "Rewrite meta description",
  ADD_H1: "Add H1 heading",
  ADD_CANONICAL: "Add canonical tag",
  ADD_SCHEMA: "Add structured data",
  SET_IMAGE_ALT: "Add image alt text",
  FIX_REDIRECT_CHAIN: "Collapse redirect chain",
  DEFER_SCRIPTS: "Defer blocking scripts",
  ADD_ROBOTS_TXT: "Create robots.txt",
  ADD_SITEMAP: "Create XML sitemap",
};

const STATUS_LABEL: Record<OptimizationStatus, string> = {
  pending: "To review",
  approved: "Approved",
  rejected: "Rejected",
  applied: "Applied",
};

/** Rendered as a block rather than inline when the value is real markup. */
const BLOCK_ACTIONS = new Set<OptimizationAction>([
  "ADD_SCHEMA",
  "ADD_SITEMAP",
  "ADD_ROBOTS_TXT",
  "DEFER_SCRIPTS",
  "ADD_CANONICAL",
  "ADD_H1",
]);

const FILTERS: Array<{ key: OptimizationStatus | "all"; label: string }> = [
  { key: "pending", label: "To review" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

export function OptimizationsPanel({ crawlId }: { crawlId: string }) {
  const [items, setItems] = useState<Optimization[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<OptimizationRunResult | null>(null);
  const [filter, setFilter] = useState<OptimizationStatus | "all">("pending");
  const [openAction, setOpenAction] = useState<OptimizationAction | null>(null);
  // Ids currently being written, so a row can't be double-submitted.
  const [saving, setSaving] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const res = await getCrawlOptimizations(crawlId);
    setItems(res.optimizations);
    setTruncated(res.truncated);
  }, [crawlId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCrawlOptimizations(crawlId)
      .then((res) => {
        if (cancelled) return;
        setItems(res.optimizations);
        setTruncated(res.truncated);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load optimizations.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [crawlId]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      setRun(await generateCrawlOptimizations(crawlId));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed.");
    } finally {
      setGenerating(false);
    }
  }

  async function review(item: Optimization, status: OptimizationStatus) {
    setSaving((prev) => new Set(prev).add(item.id));
    // Optimistic: the row moves out of "To review" immediately, and is put
    // back with its old status if the write fails.
    const previous = item.status;
    setItems((prev) => prev.map((o) => (o.id === item.id ? { ...o, status } : o)));
    try {
      await setOptimizationStatus(crawlId, item.id, status);
    } catch (err) {
      setItems((prev) => prev.map((o) => (o.id === item.id ? { ...o, status: previous } : o)));
      setError(err instanceof Error ? err.message : "Could not save that decision.");
    } finally {
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  }

  const counts = useMemo(() => {
    const c: Record<OptimizationStatus, number> = { pending: 0, approved: 0, rejected: 0, applied: 0 };
    for (const o of items) c[o.status] += 1;
    return c;
  }, [items]);

  const visible = useMemo(
    () => (filter === "all" ? items : items.filter((o) => o.status === filter)),
    [items, filter],
  );

  const groups = useMemo(() => {
    const byAction = new Map<OptimizationAction, Optimization[]>();
    for (const o of visible) {
      const bucket = byAction.get(o.action);
      if (bucket) bucket.push(o);
      else byAction.set(o.action, [o]);
    }
    return ACTION_ORDER.filter((a) => byAction.has(a)).map((action) => ({
      action,
      items: (byAction.get(action) ?? []).sort((a, b) => b.confidence - a.confidence),
    }));
  }, [visible]);

  if (loading) return <p className="muted small">Loading optimizations&hellip;</p>;

  return (
    <div className="opt-panel">
      <div className="opt-toolbar">
        <div className="opt-filters" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              className={`opt-filter${filter === f.key ? " opt-filter-active" : ""}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="opt-filter-count">
                {f.key === "all" ? items.length : counts[f.key]}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm opt-generate"
          onClick={handleGenerate}
          disabled={generating}
          title="Re-derive fixes from the stored crawl data. Approved and rejected proposals are kept."
        >
          {generating ? (
            <>
              <SpinnerIcon /> Generating&hellip;
            </>
          ) : items.length === 0 ? (
            "Generate fixes"
          ) : (
            "Regenerate"
          )}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {run && <RunSummary run={run} />}
      {truncated && (
        <p className="muted small">Showing the first 2,000 proposals; counts above cover them all.</p>
      )}

      {items.length === 0 && !generating && (
        <p className="muted small opt-empty">
          No fixes generated yet. &ldquo;Generate fixes&rdquo; turns this crawl&rsquo;s auto-fixable issues into
          concrete, copy-pasteable changes. Nothing is applied to your site — every proposal waits for your review.
        </p>
      )}

      {items.length > 0 && visible.length === 0 && (
        <p className="muted small opt-empty">Nothing in &ldquo;{STATUS_LABEL[filter as OptimizationStatus] ?? "All"}&rdquo;.</p>
      )}

      <ul className="issue-type-list">
        {groups.map(({ action, items: rows }) => {
          const open = openAction === action;
          return (
            <li key={action} className="issue-type">
              <button
                type="button"
                className="issue-type-head"
                onClick={() => setOpenAction(open ? null : action)}
              >
                <span className="issue-type-name">{ACTION_LABEL[action]}</span>
                {rows.some((r) => r.source === "ai") && <span className="flag-chip opt-ai-chip">AI</span>}
                <span className="issue-type-count">{rows.length}</span>
                <span className="pages-expand-chevron">{open ? "−" : "+"}</span>
              </button>
              {open && (
                <ul className="opt-list">
                  {rows.map((item) => (
                    <OptimizationRow
                      key={item.id}
                      item={item}
                      busy={saving.has(item.id)}
                      onReview={review}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RunSummary({ run }: { run: OptimizationRunResult }) {
  return (
    <div className="opt-run-summary">
      <p className="small">
        <strong>{run.generated}</strong> proposal{run.generated === 1 ? "" : "s"} written
        {run.bySource.ai > 0 && ` (${run.bySource.ai} by AI, ${run.bySource.rule} by rules)`}
        {run.preservedReviews > 0 && ` · ${run.preservedReviews} already-reviewed kept as-is`}
        {run.unhandledIssues > 0 && ` · ${run.unhandledIssues} issue(s) need a human`}
      </p>
      {!run.aiEnabled && run.aiUnavailableReason && (
        <p className="small opt-warning">
          Rule-based fixes only — {run.aiUnavailableReason}
        </p>
      )}
      {run.aiEnabled && run.aiFailedPages > 0 && (
        <p className="small opt-warning">
          AI rewrites failed on {run.aiFailedPages} page{run.aiFailedPages === 1 ? "" : "s"}
          {run.aiError ? ` — ${run.aiError}` : "."} The rule-based fixes above are unaffected.
        </p>
      )}
      {run.aiPagesSkipped > 0 && (
        <p className="small opt-warning">
          {run.aiPagesSkipped} page(s) got rule-based fixes only: the AI pass is capped per run. Raise
          OPTIMIZER_MAX_PAGES to cover more.
        </p>
      )}
    </div>
  );
}

function OptimizationRow({
  item,
  busy,
  onReview,
}: {
  item: Optimization;
  busy: boolean;
  onReview: (item: Optimization, status: OptimizationStatus) => void;
}) {
  const [copied, setCopied] = useState(false);
  const block = BLOCK_ACTIONS.has(item.action);

  async function copy() {
    try {
      await navigator.clipboard.writeText(item.newValue);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard is unavailable outside a secure context; the value is
      // already on screen and selectable, so this is not worth an error.
    }
  }

  return (
    <li className={`opt-row opt-row-${item.status}`}>
      <div className="opt-row-head">
        {item.url && (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            className="issue-url opt-row-url"
            title={item.url}
          >
            {item.url}
          </a>
        )}
        <span className={`risk-chip risk-${item.risk}`}>{item.risk} risk</span>
        <span className="opt-confidence" title="How confident the generator is in this exact value">
          {item.confidence}%
        </span>
        <span className={`flag-chip opt-source-${item.source}`}>
          {item.source === "ai" ? item.model ?? "AI" : "rule"}
        </span>
      </div>

      {item.target && <div className="opt-target muted small">{item.target}</div>}

      {item.oldValue && (
        <div className="opt-value opt-value-old">
          <span className="opt-value-label">Now</span>
          <pre className={block ? "opt-code" : "opt-text"}>{item.oldValue}</pre>
        </div>
      )}
      <div className="opt-value opt-value-new">
        <span className="opt-value-label">Proposed</span>
        <pre className={block ? "opt-code" : "opt-text"}>{item.newValue}</pre>
      </div>

      <p className="opt-reason small">{item.reason}</p>

      <div className="opt-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        {item.status !== "approved" && (
          <button
            type="button"
            className="btn btn-ghost btn-sm opt-approve"
            disabled={busy}
            onClick={() => onReview(item, "approved")}
          >
            Approve
          </button>
        )}
        {item.status !== "rejected" && (
          <button
            type="button"
            className="btn btn-ghost btn-sm opt-reject"
            disabled={busy}
            onClick={() => onReview(item, "rejected")}
          >
            Reject
          </button>
        )}
        {item.status === "approved" && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => onReview(item, "applied")}
            title="Mark as shipped once you've made the change on the site"
          >
            Mark applied
          </button>
        )}
        {item.status !== "pending" && (
          <span className={`opt-status-chip opt-status-${item.status}`}>{STATUS_LABEL[item.status]}</span>
        )}
      </div>
    </li>
  );
}
