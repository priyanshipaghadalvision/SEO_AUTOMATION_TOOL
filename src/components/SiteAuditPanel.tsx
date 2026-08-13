import type { SiteAudit } from "../api/client";

function statusIcon(ok: boolean) {
  return <span className={`audit-icon ${ok ? "audit-icon-ok" : "audit-icon-bad"}`}>{ok ? "✓" : "✗"}</span>;
}

/**
 * Site-wide findings from the crawl's setup phase. Shown above the page list
 * because robots.txt and the sitemap describe the whole site, not any one
 * page -- and both directly explain how much the crawler was able to reach.
 */
export function SiteAuditPanel({ audit }: { audit: SiteAudit | null }) {
  if (!audit) {
    return <p className="muted small site-audit-empty">Site checks unavailable — this crawl predates them.</p>;
  }

  const { robots, sitemap } = audit;
  const robotsPath = (() => {
    try {
      return new URL(robots.url).pathname;
    } catch {
      return robots.url;
    }
  })();

  return (
    <div className="site-audit">
      <div className={`audit-card${robots.found ? "" : " audit-card-bad"}`}>
        <div className="audit-head">
          {statusIcon(robots.found)}
          <span className="audit-title">Robots.txt</span>
          <span className={`audit-verdict${robots.found ? "" : " audit-verdict-bad"}`}>
            {robots.found ? "Found" : "Not found"}
          </span>
        </div>
        <dl className="audit-rows">
          <div>
            <dt>Status</dt>
            <dd>{robots.status ?? "no response"}</dd>
          </div>
          <div>
            <dt>URL</dt>
            <dd className="audit-mono">{robotsPath}</dd>
          </div>
          {robots.found && (
            <div>
              <dt>Size</dt>
              <dd>{robots.sizeBytes} bytes</dd>
            </div>
          )}
          <div>
            <dt>Sitemaps declared</dt>
            <dd>{robots.sitemapsDeclared.length > 0 ? robots.sitemapsDeclared.length : "none"}</dd>
          </div>
        </dl>
        {robots.blocksEverything && (
          <p className="audit-alert">Blocks crawling of the homepage — this severely limits what can be indexed.</p>
        )}
        {robots.error && <p className="audit-alert">{robots.error}</p>}
      </div>

      <div className={`audit-card${sitemap.found ? "" : " audit-card-bad"}`}>
        <div className="audit-head">
          {statusIcon(sitemap.found)}
          <span className="audit-title">Sitemap</span>
          <span className={`audit-verdict${sitemap.found ? "" : " audit-verdict-bad"}`}>
            {sitemap.found ? "Found" : "Not found"}
          </span>
        </div>
        <dl className="audit-rows">
          <div>
            <dt>Discovered via</dt>
            <dd>
              {sitemap.source === "robots"
                ? "robots.txt declaration"
                : sitemap.source === "common"
                  ? "/sitemap.xml"
                  : "not discovered"}
            </dd>
          </div>
          <div>
            <dt>URLs listed</dt>
            <dd>{sitemap.urlCount.toLocaleString()}</dd>
          </div>
          {sitemap.locations.length > 0 && (
            <div>
              <dt>Location</dt>
              <dd className="audit-mono audit-truncate" title={sitemap.locations.join(", ")}>
                {sitemap.locations[0]}
              </dd>
            </div>
          )}
        </dl>
        {!sitemap.found && !sitemap.error && (
          <p className="audit-alert">
            No sitemap found. Search engines rely on links alone to discover pages here.
          </p>
        )}
        {sitemap.error && <p className="audit-alert">{sitemap.error}</p>}
      </div>
    </div>
  );
}
