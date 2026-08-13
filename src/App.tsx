import { Fragment, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Crawl, User, Website } from "./api/client";
import {
  UnauthorizedError,
  deleteWebsite,
  getMe,
  logout as logoutRequest,
  cancelCrawl,
  createWebsite,
  getCrawl,
  getWebsite,
  listWebsites,
  queueCrawl,
  redetectPlatform,
} from "./api/client";
import { AuthScreen } from "./components/AuthScreen";
import { CrawlPagesModal } from "./components/CrawlPagesModal";
import { GscPanel } from "./components/GscPanel";
import {
  ChevronDownIcon,
  EyeIcon,
  GlobeIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  SpinnerIcon,
  StopIcon,
  TrashIcon,
} from "./components/icons";
import "./App.css";

const PLATFORM_LABELS: Record<string, string> = {
  nextjs: "Next.js",
  wordpress: "WordPress",
  shopify: "Shopify",
  react: "React",
  parked: "Parked / For Sale",
  custom: "Custom",
  unknown: "Unknown",
};

const STATUS_CLASS: Record<string, string> = {
  QUEUED: "badge badge-queued",
  RUNNING: "badge badge-running",
  COMPLETED: "badge badge-completed",
  FAILED: "badge badge-failed",
  CANCELLED: "badge badge-cancelled",
};

const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING"]);

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Newest first everywhere in the UI. The API returns createdAt-ascending
// (insertion order), so this is purely a display concern.
function newestFirst<T extends { createdAt: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function Dashboard({ user, onSignedOut }: { user: User; onSignedOut: () => void }) {
  const [websites, setWebsites] = useState<Website[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [urlInput, setUrlInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [crawlsByWebsite, setCrawlsByWebsite] = useState<Record<string, Crawl[]>>({});
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [redetectingId, setRedetectingId] = useState<string | null>(null);
  // websiteId travels alongside the crawl: the merged URL view spans a whole
  // site rather than a single crawl, so it needs the parent id too.
  const [viewingCrawl, setViewingCrawl] = useState<{
    id: string;
    websiteId: string;
    domain: string;
    crawl: Crawl;
  } | null>(null);

  async function refreshWebsites() {
    setLoading(true);
    setListError(null);
    try {
      const { websites: rows } = await listWebsites();
      setWebsites(rows);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onSignedOut();
        return;
      }
      setListError(err instanceof Error ? err.message : "Failed to load websites.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshWebsites();
  }, []);

  const sortedWebsites = useMemo(() => newestFirst(websites), [websites]);

  const stats = useMemo(() => {
    const needsAttention = websites.filter((w) => w.platform === "parked" || w.platform === "unknown").length;
    const platformsDetected = new Set(
      websites.filter((w) => w.platform !== "unknown" && w.platform !== "parked").map((w) => w.platform),
    ).size;
    return { total: websites.length, needsAttention, platformsDetected };
  }, [websites]);

  const activeCrawlIds = expandedId
    ? (crawlsByWebsite[expandedId] ?? [])
        .filter((c) => ACTIVE_STATUSES.has(c.status))
        .map((c) => c.id)
        .sort()
        .join(",")
    : "";

  // Live progress: poll only the active (non-terminal) crawls of the
  // currently expanded website. Restarts only when that active set changes
  // (a crawl starts or finishes), not on every stats tick.
  useEffect(() => {
    if (!expandedId || !activeCrawlIds) return;
    const ids = activeCrawlIds.split(",");

    const interval = setInterval(async () => {
      try {
        const updates = await Promise.all(ids.map((id) => getCrawl(id)));
        setCrawlsByWebsite((prev) => {
          const current = prev[expandedId] ?? [];
          const updatedMap = new Map(updates.map((u) => [u.crawl.id, u.crawl]));
          return { ...prev, [expandedId]: current.map((c) => updatedMap.get(c.id) ?? c) };
        });
      } catch (err) {
        console.error("Failed to poll crawl status", err);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [expandedId, activeCrawlIds]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!urlInput.trim()) return;

    setSubmitting(true);
    setFormError(null);
    try {
      const { website } = await createWebsite(urlInput.trim());
      setUrlInput("");
      setWebsites((prev) => [website, ...prev]);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to add website.");
    } finally {
      setSubmitting(false);
    }
  }

  async function loadHistory(websiteId: string) {
    setHistoryLoadingId(websiteId);
    try {
      const { crawls } = await getWebsite(websiteId);
      setCrawlsByWebsite((prev) => ({ ...prev, [websiteId]: newestFirst(crawls) }));
    } catch (err) {
      console.error("Failed to load crawls", err);
    } finally {
      setHistoryLoadingId(null);
    }
  }

  function toggleExpand(website: Website) {
    if (expandedId === website.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(website.id);
    if (!crawlsByWebsite[website.id]) {
      loadHistory(website.id);
    }
  }

  async function handleRedetectPlatform(websiteId: string) {
    setRedetectingId(websiteId);
    try {
      const { website } = await redetectPlatform(websiteId);
      setWebsites((prev) => prev.map((w) => (w.id === websiteId ? website : w)));
    } catch (err) {
      console.error("Failed to re-check platform", err);
    } finally {
      setRedetectingId(null);
    }
  }

  async function handleDeleteWebsite(website: Website) {
    const history = crawlsByWebsite[website.id];
    const activeCrawl = (history ?? []).find((c) => ACTIVE_STATUSES.has(c.status));
    const crawlCount = history?.length;

    if (
      !window.confirm(
        `Permanently delete ${website.domain}?\n\n` +
          `This erases the website, ${crawlCount === undefined ? "all of its crawls" : `all ${crawlCount} crawl(s)`}, ` +
          `every crawled page, and its history.` +
          (activeCrawl ? "\n\nIts in-progress crawl will be stopped." : "") +
          `\n\nThis cannot be undone.`,
      )
    ) {
      return;
    }

    setDeletingId(website.id);
    setListError(null);
    try {
      await deleteWebsite(website.id);
      setWebsites((prev) => prev.filter((w) => w.id !== website.id));
      setCrawlsByWebsite((prev) => {
        const next = { ...prev };
        delete next[website.id];
        return next;
      });
      if (expandedId === website.id) setExpandedId(null);
      // Close the pages modal if it was showing a crawl that just got deleted.
      if (viewingCrawl && (history ?? []).some((c) => c.id === viewingCrawl.id)) setViewingCrawl(null);
    } catch (err) {
      console.error("Failed to delete website", err);
      setListError(err instanceof Error ? err.message : "Failed to delete website.");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleCancelCrawl(websiteId: string, crawlId: string) {
    setCancellingId(crawlId);
    try {
      const { crawl } = await cancelCrawl(crawlId);
      // Patch just this crawl rather than refetching: the worker may still
      // be winding the crawl down, and a refetch would race that.
      setCrawlsByWebsite((prev) => ({
        ...prev,
        [websiteId]: (prev[websiteId] ?? []).map((c) => (c.id === crawlId ? crawl : c)),
      }));
    } catch (err) {
      console.error("Failed to cancel crawl", err);
    } finally {
      setCancellingId(null);
    }
  }

  async function handleStartCrawl(website: Website) {
    setStartingId(website.id);
    try {
      await queueCrawl(website.id);
      setExpandedId(website.id);
      // Re-fetch the full history rather than locally prepending: if this
      // site's history hadn't been loaded yet, a local prepend would hide
      // its real past crawls behind a list containing only the new one.
      await loadHistory(website.id);
    } catch (err) {
      console.error("Failed to start crawl", err);
    } finally {
      setStartingId(null);
    }
  }

  async function handleSignOut() {
    try {
      await logoutRequest();
    } catch (err) {
      // Even if the server call fails the local session must end, otherwise
      // the user is stuck looking at data they asked to sign out of.
      console.error("Logout request failed", err);
    }
    onSignedOut();
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark">SEO</span>
            <div>
              <h1>Autonomous SEO Platform</h1>
              <p className="subtitle">Crawl, extract, and monitor SEO signals across every site you track.</p>
            </div>
          </div>
          <div className="topbar-user">
            <div className="user-chip" title={user.email}>
              <span className="user-avatar">{(user.name || user.email).charAt(0).toUpperCase()}</span>
              <span className="user-email">{user.name || user.email}</span>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="content">
        <section className="stats-row">
          <div className="stat-card">
            <span className="stat-value">{stats.total}</span>
            <span className="stat-label">Websites tracked</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{stats.platformsDetected}</span>
            <span className="stat-label">Platforms detected</span>
          </div>
          <div className={`stat-card${stats.needsAttention > 0 ? " stat-card-warning" : ""}`}>
            <span className="stat-value">{stats.needsAttention}</span>
            <span className="stat-label">Needs attention</span>
          </div>
        </section>

        <GscPanel websites={websites} />

        <section className="card">
          <div className="card-header-row">
            <h2>Add a website</h2>
          </div>
          <form className="add-form" onSubmit={handleSubmit}>
            <div className="input-with-icon">
              <GlobeIcon />
              <input
                type="text"
                placeholder="example.com or https://example.com"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                disabled={submitting}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={submitting || !urlInput.trim()}>
              {submitting ? (
                <>
                  <SpinnerIcon /> Adding&hellip;
                </>
              ) : (
                <>
                  <PlusIcon /> Add website
                </>
              )}
            </button>
          </form>
          {formError && <p className="error-text">{formError}</p>}
        </section>

        <section className="card websites-card">
          <div className="card-header-row">
            <h2>Websites</h2>
            <button type="button" className="btn btn-ghost" onClick={refreshWebsites} disabled={loading}>
              <RefreshIcon /> Refresh
            </button>
          </div>

          {loading && <p className="muted">Loading&hellip;</p>}
          {listError && <p className="error-text">{listError}</p>}
          {!loading && !listError && websites.length === 0 && (
            <p className="muted">No websites yet &mdash; add one above to queue its first crawl.</p>
          )}

          {!loading && !listError && websites.length > 0 && (
            <div className="websites-table-wrap">
              <table className="websites-table">
                <thead>
                  <tr>
                    <th>Website</th>
                    <th>Platform</th>
                    <th>Added</th>
                    <th className="actions-head" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {sortedWebsites.map((website) => {
                    const isExpanded = expandedId === website.id;
                    const history = crawlsByWebsite[website.id];
                    const activeCrawl = (history ?? []).find((c) => ACTIVE_STATUSES.has(c.status));
                    const isStarting = startingId === website.id;

                    return (
                      <Fragment key={website.id}>
                        <tr className="website-row-tr">
                          <td className="website-cell">
                            <div className="website-domain-row">
                              <span className="domain">{website.domain}</span>
                            </div>
                            <a
                              className="muted small website-url"
                              href={website.originalUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                            >
                              {website.originalUrl}
                            </a>
                          </td>
                          <td>
                            <span className={`platform-tag${website.platform === "parked" ? " platform-tag-warning" : ""}`}>
                              {PLATFORM_LABELS[website.platform] ?? website.platform}
                            </span>
                          </td>
                          <td className="muted small nowrap">{formatDate(website.createdAt)}</td>
                          <td className="actions-cell">
                            {activeCrawl ? (
                              <button
                                type="button"
                                className="btn btn-danger btn-sm"
                                onClick={() => handleCancelCrawl(website.id, activeCrawl.id)}
                                disabled={cancellingId === activeCrawl.id}
                                title="Stop this crawl"
                              >
                                {cancellingId === activeCrawl.id ? (
                                  <>
                                    <SpinnerIcon /> Stopping&hellip;
                                  </>
                                ) : (
                                  <>
                                    <StopIcon /> Stop Crawl
                                  </>
                                )}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={() => handleStartCrawl(website)}
                                disabled={isStarting}
                                title="Start a new crawl"
                              >
                                {isStarting ? (
                                  <>
                                    <SpinnerIcon /> Starting&hellip;
                                  </>
                                ) : (
                                  <>
                                    <PlayIcon /> Start Crawl
                                  </>
                                )}
                              </button>
                            )}
                            <button
                              type="button"
                              className="icon-button"
                              title="Re-check platform"
                              aria-label={`Re-check platform for ${website.domain}`}
                              onClick={() => handleRedetectPlatform(website.id)}
                              disabled={redetectingId === website.id}
                            >
                              <RefreshIcon />
                            </button>
                            <button
                              type="button"
                              className="icon-button icon-button-danger"
                              title="Delete website permanently"
                              aria-label={`Delete ${website.domain}`}
                              onClick={() => handleDeleteWebsite(website)}
                              disabled={deletingId === website.id}
                            >
                              {deletingId === website.id ? <SpinnerIcon /> : <TrashIcon />}
                            </button>
                            <button
                              type="button"
                              className={`icon-button chevron-button${isExpanded ? " chevron-button-open" : ""}`}
                              title={isExpanded ? "Hide crawl history" : "Show crawl history"}
                              aria-label={`${isExpanded ? "Hide" : "Show"} crawl history for ${website.domain}`}
                              aria-expanded={isExpanded}
                              onClick={() => toggleExpand(website)}
                            >
                              <ChevronDownIcon />
                            </button>
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr className="website-detail-row">
                            <td colSpan={4}>
                              <div className="crawl-panel">
                                <div className="crawl-panel-header">
                                  <h3 className="crawl-panel-title">Crawl history</h3>
                                  {history && history.length > 0 && (
                                    <span className="crawl-count-pill">
                                      {history.length} run{history.length === 1 ? "" : "s"}
                                    </span>
                                  )}
                                </div>

                                {historyLoadingId === website.id && !history && (
                                  <p className="muted small crawl-panel-empty">Loading crawl history&hellip;</p>
                                )}

                                {history?.length === 0 && (
                                  <p className="muted small crawl-panel-empty">
                                    No crawls yet &mdash; use <strong>Start Crawl</strong> to run the first one.
                                  </p>
                                )}

                                {history && history.length > 0 && (
                                  <div className="crawl-table-wrap">
                                    <table className="crawl-table">
                                      <thead>
                                        <tr>
                                          <th>Status</th>
                                          <th>Progress</th>
                                          <th>Limits</th>
                                          <th>Created</th>
                                          <th className="crawl-table-actions-head" aria-label="Actions" />
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {history.map((crawl) => {
                                          // maxPages is a ceiling, not a target -- most crawls finish long
                                          // before hitting it once the site runs out of new pages. Once
                                          // terminal, the bar is always full (nothing more will happen);
                                          // while active, it tracks processed-vs-discovered-so-far so it
                                          // reflects real progress instead of an arbitrary cap.
                                          const isTerminal =
                                            crawl.status === "COMPLETED" ||
                                            crawl.status === "FAILED" ||
                                            crawl.status === "CANCELLED";
                                          const pct = isTerminal
                                            ? 100
                                            : crawl.stats.discovered > 0
                                              ? Math.min(100, Math.round((crawl.stats.processed / crawl.stats.discovered) * 100))
                                              : 0;
                                          const fillClass = `progress-bar-fill${isTerminal ? ` progress-bar-fill-${crawl.status.toLowerCase()}` : ""}`;
                                          return (
                                            <tr key={crawl.id}>
                                              <td>
                                                <span className={STATUS_CLASS[crawl.status] ?? "badge"}>{crawl.status}</span>
                                                {crawl.status === "FAILED" && crawl.failureReason && (
                                                  <div className="error-text small crawl-failure-reason">
                                                    {crawl.failureReason}
                                                  </div>
                                                )}
                                              </td>
                                              <td>
                                                {crawl.status === "QUEUED" ? (
                                                  <span className="muted small">not started</span>
                                                ) : (
                                                  <>
                                                    <div className="progress-cell">
                                                      <div className="progress-bar">
                                                        <div className={fillClass} style={{ width: `${pct}%` }} />
                                                      </div>
                                                      <span className="muted small progress-count">
                                                        {isTerminal
                                                          ? `${crawl.stats.processed} page${crawl.stats.processed === 1 ? "" : "s"}`
                                                          : `${crawl.stats.processed}/${crawl.stats.discovered || "?"}`}
                                                      </span>
                                                    </div>
                                                    {(crawl.stats.failed > 0 ||
                                                      crawl.stats.skipped > 0 ||
                                                      crawl.stats.rendered > 0) && (
                                                      <div className="progress-substats">
                                                        {crawl.stats.failed > 0 && (
                                                          <span className="stat-chip stat-chip-danger">
                                                            {crawl.stats.failed} failed
                                                          </span>
                                                        )}
                                                        {crawl.stats.skipped > 0 && (
                                                          <span className="stat-chip">{crawl.stats.skipped} skipped</span>
                                                        )}
                                                        {crawl.stats.rendered > 0 && (
                                                          <span className="stat-chip stat-chip-accent">
                                                            {crawl.stats.rendered} rendered
                                                          </span>
                                                        )}
                                                      </div>
                                                    )}
                                                  </>
                                                )}
                                              </td>
                                              <td>
                                                <div className="limits-chips">
                                                  <span className="stat-chip">{crawl.limits.maxPages} pages</span>
                                                  <span className="stat-chip">depth {crawl.limits.maxDepth}</span>
                                                  <span className="stat-chip">{crawl.limits.timeLimitMinutes}min</span>
                                                </div>
                                              </td>
                                              <td className="muted small nowrap">{formatDate(crawl.createdAt)}</td>
                                              <td>
                                                <div className="crawl-row-actions">
                                                  {ACTIVE_STATUSES.has(crawl.status) && (
                                                    <button
                                                      type="button"
                                                      className="icon-button icon-button-danger"
                                                      title="Stop this crawl"
                                                      aria-label={`Stop crawl for ${website.domain}`}
                                                      onClick={() => handleCancelCrawl(website.id, crawl.id)}
                                                      disabled={cancellingId === crawl.id}
                                                    >
                                                      {cancellingId === crawl.id ? <SpinnerIcon /> : <StopIcon />}
                                                    </button>
                                                  )}
                                                  <button
                                                    type="button"
                                                    className="icon-button"
                                                    title="View crawled pages"
                                                    aria-label={`View crawled pages for ${website.domain}`}
                                                    onClick={() => setViewingCrawl({ id: crawl.id, websiteId: website.id, domain: website.domain, crawl })}
                                                  >
                                                    <EyeIcon />
                                                  </button>
                                                </div>
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
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
          )}
        </section>
      </main>

      {viewingCrawl && (
        <CrawlPagesModal
          crawlId={viewingCrawl.id}
          websiteId={viewingCrawl.websiteId}
          domain={viewingCrawl.domain}
          crawl={viewingCrawl.crawl}
          onClose={() => setViewingCrawl(null)}
        />
      )}
    </div>
  );
}

/**
 * Session gate. Renders nothing until the existing cookie has been checked,
 * so a signed-in user never sees the login screen flash on refresh.
 */
function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    getMe()
      .then(({ user: me }) => setUser(me))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="auth-page" />;
  if (!user) return <AuthScreen onAuthenticated={setUser} />;
  return <Dashboard user={user} onSignedOut={() => setUser(null)} />;
}

export default App;
