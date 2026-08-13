import { Fragment, useEffect, useMemo, useState } from "react";
import type { Crawl, DuplicateGroup, Page, PageSummary } from "../api/client";
import { getCrawlDuplicates, getCrawlPages, getPage } from "../api/client";
import { PageDetail } from "./PageDetail";
import { SiteAuditPanel } from "./SiteAuditPanel";
import { IssuesPanel } from "./IssuesPanel";
import { OptimizationsPanel } from "./OptimizationsPanel";
import { SiteUrlsPanel } from "./SiteUrlsPanel";
import "./CrawlPagesModal.css";

interface CrawlPagesModalProps {
  crawlId: string;
  /** Needed for the merged URL view, which spans crawls rather than one. */
  websiteId?: string;
  domain: string;
  /** Carries siteAudit; may be absent if the caller hasn't loaded it. */
  crawl?: Crawl;
  onClose: () => void;
}

const PAGE_LIMIT = 200;

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

export function CrawlPagesModal({ crawlId, websiteId, domain, crawl, onClose }: CrawlPagesModalProps) {
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"urls" | "issues" | "fixes" | "pages">("urls");

  // Full page records, fetched only when a row is expanded and then cached
  // so re-opening the same row is instant and costs no second request.
  const [details, setDetails] = useState<Record<string, Page>>({});
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getCrawlPages(crawlId, { limit: PAGE_LIMIT }), getCrawlDuplicates(crawlId)])
      .then(([list, dupes]) => {
        if (cancelled) return;
        setPages(list.pages);
        setTotal(list.total);
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
  }, [crawlId]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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

  const filteredPages = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return pages;
    return pages.filter(
      (p) => p.url.toLowerCase().includes(term) || (p.title ?? "").toLowerCase().includes(term),
    );
  }, [pages, search]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Crawled pages for ${domain}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h3>Crawled pages</h3>
            <p className="muted small">{domain}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="modal-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "urls"}
            className={`modal-tab${tab === "urls" ? " modal-tab-active" : ""}`}
            onClick={() => setTab("urls")}
            title="Every URL, with crawl data and Search Console side by side"
          >
            All URLs
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "pages"}
            className={`modal-tab${tab === "pages" ? " modal-tab-active" : ""}`}
            onClick={() => setTab("pages")}
          >
            Pages{total > 0 ? ` (${total})` : ""}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "issues"}
            className={`modal-tab${tab === "issues" ? " modal-tab-active" : ""}`}
            onClick={() => setTab("issues")}
          >
            SEO Issues
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "fixes"}
            className={`modal-tab${tab === "fixes" ? " modal-tab-active" : ""}`}
            onClick={() => setTab("fixes")}
          >
            Fixes
          </button>
        </div>

        <div className="modal-body">
          {tab === "urls" && websiteId && <SiteUrlsPanel websiteId={websiteId} />}
          {tab === "urls" && !websiteId && (
            <p className="muted small">
              This view needs the website id, which this crawl was opened without.
            </p>
          )}
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
              <div className="modal-summary">
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
                <input
                  type="text"
                  className="modal-search"
                  placeholder="Filter by URL or title&hellip;"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
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
                  <p className="muted small pages-no-match">No pages match &ldquo;{search}&rdquo;.</p>
                )}
              </div>
            </>
          )}
          </>
          )}
        </div>
      </div>
    </div>
  );
}
