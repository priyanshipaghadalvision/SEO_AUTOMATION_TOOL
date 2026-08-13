import { Fragment, useEffect, useMemo, useState } from "react";
import type { Crawl, DuplicateGroup, Page, PageSummary } from "../api/client";
import { getCrawlDuplicates, getCrawlPages, getPage } from "../api/client";
import { PageDetail } from "./PageDetail";
import { SiteAuditPanel } from "./SiteAuditPanel";
import { IssuesPanel } from "./IssuesPanel";
import { OptimizationsPanel } from "./OptimizationsPanel";
import { SiteUrlsPanel } from "./SiteUrlsPanel";
import { Pagination } from "./Pagination";
import { GSC_TABS, GscDataPanel } from "./GscDataPanel";
import type { GscTab } from "./GscDataPanel";
import "./Panel.css";
import "./Modal.css";
import "./SitePage.css";

interface SitePageProps {
  crawlId: string;
  /** The merged URL view spans a whole site, not one crawl. */
  websiteId?: string;
  domain: string;
  /** Carries siteAudit; may be absent if the caller hasn't loaded it. */
  crawl?: Crawl;
  /** Returns to the dashboard. */
  onBack: () => void;
}

/**
 * Search Console sections are namespaced rather than flattened in, so adding a
 * tab to GscDataPanel needs no edit here -- GSC_TABS drives that group.
 */
type Section = "urls" | "pages" | "issues" | "fixes" | `gsc:${GscTab}`;

interface NavGroup {
  title: string | null;
  items: Array<{ key: Section; label: string; hint?: string }>;
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: null,
    items: [
      { key: "urls", label: "All URLs", hint: "Every URL, crawl data and Search Console side by side" },
      { key: "pages", label: "Crawled pages", hint: "What this crawl fetched, with full per-page detail" },
      { key: "issues", label: "SEO issues", hint: "Findings grouped by type, with evidence" },
      { key: "fixes", label: "Fixes", hint: "Concrete proposed changes awaiting review" },
    ],
  },
  {
    title: "Search Console",
    items: GSC_TABS.map((t) => ({ key: `gsc:${t.key}` as Section, label: t.label })),
  },
];

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString();
}

function httpStatusClass(status: number | null): string {
  if (status === null) return "http-badge http-badge-error";
  if (status < 300) return "http-badge http-badge-ok";
  if (status < 400) return "http-badge http-badge-redirect";
  if (status < 500) return "http-badge http-badge-client-error";
  return "http-badge http-badge-server-error";
}

function renderBadge(method: PageSummary["renderMethod"]) {
  if (method === "browser") return <span className="render-badge render-badge-browser">Rendered</span>;
  if (method === "http") return <span className="render-badge render-badge-http">HTTP</span>;
  return null;
}

export function SitePage({ crawlId, websiteId, domain, crawl, onBack }: SitePageProps) {
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  /** Term actually sent to the server; `search` is the box's live text. */
  const [applied, setApplied] = useState("");
  const [matched, setMatched] = useState(0);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Section>("urls");

  // Full page records, fetched only when a row is expanded and then cached
  // so re-opening the same row is instant and costs no second request.
  const [details, setDetails] = useState<Record<string, Page>>({});
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);

  useEffect(() => setOffset(0), [crawlId, applied]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      getCrawlPages(crawlId, { limit: pageSize, offset, search: applied || undefined }),
      getCrawlDuplicates(crawlId),
    ])
      .then(([list, dupes]) => {
        if (cancelled) return;
        setPages(list.pages);
        setTotal(list.total);
        setMatched(list.matched);
        setDuplicates(dupes.duplicateGroups);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load pages.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [crawlId, pageSize, offset, applied]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onBack();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onBack]);

  async function toggleRow(page: PageSummary) {
    if (expandedId === page.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(page.id);
    if (details[page.id]) return;

    setDetailLoadingId(page.id);
    try {
      const { page: full } = await getPage(crawlId, page.id);
      setDetails((prev) => ({ ...prev, [page.id]: full }));
    } catch (err) {
      console.error("Failed to load page detail", err);
    } finally {
      setDetailLoadingId(null);
    }
  }

  const renderedCount = useMemo(() => pages.filter((p) => p.renderMethod === "browser").length, [pages]);
  const missingTitleCount = useMemo(() => pages.filter((p) => p.httpStatus && !p.title).length, [pages]);
  const noindexCount = useMemo(() => pages.filter((p) => p.noindex).length, [pages]);
  const duplicatePageCount = useMemo(
    () => duplicates.reduce((sum, g) => sum + g.count, 0),
    [duplicates],
  );
  // Hashes that belong to a duplicate group, so each affected row can be flagged.
  const duplicateHashes = useMemo(() => new Set(duplicates.map((g) => g.hash)), [duplicates]);

  /*
   * No client-side filter any more.
   *
   * The rows on screen are one page of a server-side query that already
   * applied the search term, so re-filtering them would only ever hide rows
   * the database deliberately returned.
   */
  const filteredPages = pages;

  return (
    <div className="site-page">
      <header className="site-page-header">
        <button type="button" className="btn btn-ghost btn-sm site-back" onClick={onBack}>
          &larr; All websites
        </button>
        <div className="site-page-title">
          <h2>{domain}</h2>
          <p className="muted small">
            {total > 0 ? `${total.toLocaleString()} pages crawled` : "Crawl detail"}
          </p>
        </div>
      </header>

        <div className="site-layout">
          {/* Sidebar rather than a tab strip: the section list keeps growing,
              and vertical space is far cheaper than horizontal here -- tabs
              were already wrapping. It also leaves room for per-section
              counts, which a cramped tab cannot show. */}
          <nav className="site-nav" aria-label="Sections">
            {NAV_GROUPS.map((group) => (
              <Fragment key={group.title ?? "main"}>
                {group.title && <p className="site-nav-group">{group.title}</p>}
                {group.items.map((sec) => (
                  <button
                    key={sec.key}
                    type="button"
                    aria-current={tab === sec.key}
                    className={`site-nav-item${tab === sec.key ? " site-nav-item-active" : ""}`}
                    onClick={() => setTab(sec.key)}
                    title={sec.hint}
                  >
                    <span className="site-nav-label">{sec.label}</span>
                    {sec.key === "pages" && total > 0 && (
                      <span className="site-nav-count">{total.toLocaleString()}</span>
                    )}
                  </button>
                ))}
              </Fragment>
            ))}
          </nav>

          <div className="site-content">
          {tab === "urls" && websiteId && <SiteUrlsPanel websiteId={websiteId} />}
          {tab === "urls" && !websiteId && (
            <p className="muted small">
              This view needs the website id, which this crawl was opened without.
            </p>
          )}

          {tab.startsWith("gsc:") &&
            (websiteId ? (
              <GscDataPanel
                websiteId={websiteId}
                domain={domain}
                tab={tab.slice(4) as GscTab}
              />
            ) : (
              <p className="muted small">
                Search Console data is per website, and this crawl was opened without the website id.
              </p>
            ))}
          {tab === "issues" && <IssuesPanel crawlId={crawlId} />}
          {tab === "fixes" && <OptimizationsPanel crawlId={crawlId} />}

          {tab === "pages" && (
          <>
          {loading && <p className="muted small">Loading pages&hellip;</p>}
          {error && <p className="error-text">{error}</p>}

          {!loading && !error && pages.length === 0 && (
            <p className="muted small">No pages recorded for this crawl yet.</p>
          )}

          {!loading && !error && <SiteAuditPanel audit={crawl?.siteAudit ?? null} />}

          {!loading && !error && pages.length > 0 && (
            <>
              <div className="panel-summary">
                <span className="muted small">
                  {total} page{total === 1 ? "" : "s"}
                  {renderedCount > 0 && (
                    <>
                      {" "}
                      &middot; <span className="summary-highlight">{renderedCount}</span> browser-rendered
                    </>
                  )}
                  {missingTitleCount > 0 && (
                    <>
                      {" "}
                      &middot; <span className="summary-warning">{missingTitleCount}</span> missing title
                    </>
                  )}
                  {noindexCount > 0 && (
                    <>
                      {" "}
                      &middot; <span className="summary-warning">{noindexCount}</span> noindex
                    </>
                  )}
                  {duplicatePageCount > 0 && (
                    <>
                      {" "}
                      &middot; <span className="summary-warning">{duplicatePageCount}</span> duplicate content
                      {duplicates.length > 1 && ` (${duplicates.length} groups)`}
                    </>
                  )}
                </span>
                {/* Submit-to-search, because the query now runs against all
                    10,000 pages rather than the handful already loaded --
                    firing on every keystroke would be a request per letter. */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setApplied(search.trim());
                  }}
                >
                  <input
                    type="text"
                    className="panel-search"
                    placeholder="Search all pages by URL or title, then Enter&hellip;"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </form>
              </div>

              <div className="pages-table-wrap">
                <table className="pages-table">
                  <thead>
                    <tr>
                      <th>Page</th>
                      <th>Status</th>
                      <th>Render</th>
                      <th>Words</th>
                      <th>Links</th>
                      <th>Depth</th>
                      <th>Found</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPages.map((page) => {
                      const isExpanded = expandedId === page.id;
                      const isDuplicate = page.contentHash !== null && duplicateHashes.has(page.contentHash);

                      return (
                        <Fragment key={page.id}>
                          <tr className="pages-row-clickable" onClick={() => toggleRow(page)}>
                            <td className="pages-url-cell">
                              {page.title ? (
                                <div className="pages-title">{page.title}</div>
                              ) : (
                                page.httpStatus && <div className="pages-title pages-title-missing">No title</div>
                              )}
                              <a
                                href={page.url}
                                target="_blank"
                                rel="noreferrer noopener"
                                title={page.url}
                                onClick={(e) => e.stopPropagation()}
                              >
                                {page.url}
                              </a>
                              <div className="pages-flags">
                                {page.noindex && <span className="flag-chip flag-chip-warning">noindex</span>}
                                {page.nofollow && <span className="flag-chip flag-chip-warning">nofollow</span>}
                                {isDuplicate && <span className="flag-chip flag-chip-danger">duplicate</span>}
                              </div>
                              {page.finalUrl && (
                                <div className="muted small pages-redirect-note">
                                  redirected &rarr; {page.finalUrl}
                                </div>
                              )}
                              {page.errorMessage && <div className="error-text small">{page.errorMessage}</div>}
                            </td>
                            <td>
                              <span className={httpStatusClass(page.httpStatus)}>{page.httpStatus ?? "ERR"}</span>
                            </td>
                            <td>{renderBadge(page.renderMethod)}</td>
                            <td className="muted small nowrap">{page.wordCount ?? "-"}</td>
                            <td className="muted small nowrap">
                              {page.internalLinkCount ?? 0} in / {page.externalLinkCount ?? 0} ext
                            </td>
                            <td className="muted small">{page.depth}</td>
                            <td className="muted small">
                              <div className="pages-found-cell">
                                {formatTime(page.discoveredAt)}
                                <span className="pages-expand-chevron">{isExpanded ? "−" : "+"}</span>
                              </div>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="pages-detail-row">
                              <td colSpan={7}>
                                {details[page.id] ? (
                                  <PageDetail page={details[page.id]} />
                                ) : (
                                  <p className="muted small page-detail-loading">
                                    {detailLoadingId === page.id ? "Loading details…" : "Details unavailable."}
                                  </p>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
                {filteredPages.length === 0 && (
                  <p className="muted small pages-no-match">
                    {applied ? `No pages match “${applied}”.` : "No pages on this page of results."}
                  </p>
                )}
              </div>

              {matched > 0 && (
                <Pagination
                  total={matched}
                  offset={offset}
                  pageSize={pageSize}
                  busy={loading}
                  noun="page"
                  onChange={(next) => {
                    setOffset(next.offset);
                    setPageSize(next.pageSize);
                    setExpandedId(null);
                  }}
                />
              )}
            </>
          )}
          </>
          )}
          </div>
      </div>
    </div>
  );
}
