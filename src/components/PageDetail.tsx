import { useState } from "react";
import type { Page } from "../api/client";
import {
  analyzeCanonical,
  analyzeDescription,
  analyzeHeadings,
  analyzeImages,
  analyzeStructuredData,
  analyzeTitle,
} from "../lib/seoChecks";
import type { Observation } from "../lib/seoChecks";

const HEADING_PREVIEW = 15;
const IMAGE_PREVIEW = 8;
const LINK_PREVIEW = 8;
const SCRIPT_PREVIEW = 8;
const CONTENT_PREVIEW_CHARS = 600;

function formatBytes(bytes: number | null) {
  if (bytes === null) return null;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function Note({ observation }: { observation: Observation }) {
  return <span className={`obs obs-${observation.severity}`}>{observation.message}</span>;
}

function ShowMore({ shown, total, open, onToggle }: { shown: number; total: number; open: boolean; onToggle: () => void }) {
  if (total <= shown) return null;
  return (
    <button type="button" className="show-more-button" onClick={onToggle}>
      {open ? "Show less" : `+${total - shown} more`}
    </button>
  );
}

export function PageDetail({ page }: { page: Page }) {
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const headings = page.headings ?? [];
  const images = page.images ?? [];
  const internalLinks = page.internalLinks ?? [];
  const externalLinks = page.externalLinks ?? [];
  const scripts = page.scripts ?? [];
  const ogEntries = Object.entries(page.openGraph ?? {});
  const content = page.contentText ?? "";

  const titleCheck = analyzeTitle(page.title);
  const descCheck = analyzeDescription(page.metaDescription);
  const canonicalNote = analyzeCanonical(page.canonicalUrl, page.finalUrl ?? page.url);
  const headingNotes = analyzeHeadings(headings);
  const imageSummary = analyzeImages(images);
  const schemaChecks = analyzeStructuredData(page.structuredData ?? []);

  return (
    <div className="page-detail">
      {/* ---- Meta ---- */}
      <section className="detail-section">
        <h4 className="detail-heading">Meta</h4>
        <div className="meta-row">
          <span className="meta-key">Title</span>
          <div className="meta-body">
            <p className="meta-value">{titleCheck.value ?? <em>missing</em>}</p>
            <Note observation={titleCheck.observation} />
          </div>
        </div>
        <div className="meta-row">
          <span className="meta-key">Description</span>
          <div className="meta-body">
            <p className="meta-value">{descCheck.value ?? <em>missing</em>}</p>
            <Note observation={descCheck.observation} />
          </div>
        </div>
        <div className="meta-row">
          <span className="meta-key">Canonical</span>
          <div className="meta-body">
            <p className="meta-value page-detail-mono">{page.canonicalUrl ?? <em>not declared</em>}</p>
            <Note observation={canonicalNote} />
          </div>
        </div>
        <div className="meta-row">
          <span className="meta-key">Robots</span>
          <div className="meta-body">
            <p className="meta-value page-detail-mono">
              {page.robotsMeta ?? <em>no robots meta tag</em>}
              {page.xRobotsTag && <> · X-Robots-Tag: {page.xRobotsTag}</>}
            </p>
            <Note
              observation={
                page.noindex
                  ? { severity: "error", message: "noindex — this page is excluded from search results." }
                  : { severity: "ok", message: "Indexable." }
              }
            />
          </div>
        </div>
      </section>

      {/* ---- Technical ---- */}
      <section className="detail-section">
        <h4 className="detail-heading">Technical</h4>
        <div className="page-detail-grid">
          {typeof page.wordCount === "number" && (
            <Field label="Word count" value={String(page.wordCount)} />
          )}
          {page.htmlBytes !== null && <Field label="Page weight" value={formatBytes(page.htmlBytes) ?? "-"} />}
          {page.responseTimeMs !== null && <Field label="Response time" value={`${page.responseTimeMs}ms`} />}
          {typeof page.loadTimeMs === "number" && <Field label="Render time" value={`${page.loadTimeMs}ms`} />}
          {page.lang && <Field label="Language" value={page.lang} />}
          {page.viewport && <Field label="Viewport" value={page.viewport} mono />}
        </div>
      </section>

      {/* ---- Heading hierarchy ---- */}
      <section className="detail-section">
        <h4 className="detail-heading">Heading structure ({headings.length})</h4>
        <ul className="obs-list">
          {headingNotes.map((n, i) => (
            <li key={i}>
              <Note observation={n} />
            </li>
          ))}
        </ul>
        {headings.length > 0 && (
          <>
            <ul className="page-detail-headings heading-tree">
              {(openSections.headings ? headings : headings.slice(0, HEADING_PREVIEW)).map((h, i) => (
                <li key={i} style={{ paddingLeft: `${(h.level - 1) * 18}px` }}>
                  <span className={`heading-level-tag h-level-${h.level}`}>H{h.level}</span> {h.text}
                </li>
              ))}
            </ul>
            <ShowMore
              shown={HEADING_PREVIEW}
              total={headings.length}
              open={!!openSections.headings}
              onToggle={() => toggle("headings")}
            />
          </>
        )}
      </section>

      {/* ---- Image SEO ---- */}
      <section className="detail-section">
        <h4 className="detail-heading">Image SEO ({imageSummary.total})</h4>
        {imageSummary.total === 0 ? (
          <p className="muted small">No images on this page.</p>
        ) : (
          <>
            <ul className="obs-list">
              {imageSummary.observations.map((n, i) => (
                <li key={i}>
                  <Note observation={n} />
                </li>
              ))}
            </ul>
            <div className="img-table-wrap">
              <table className="img-table">
                <thead>
                  <tr>
                    <th>Image URL</th>
                    <th>ALT</th>
                    <th>Width</th>
                    <th>Height</th>
                    <th>Lazy</th>
                  </tr>
                </thead>
                <tbody>
                  {(openSections.images ? images : images.slice(0, IMAGE_PREVIEW)).map((img, i) => (
                    <tr key={i}>
                      <td className="img-url" title={img.src}>
                        <a href={img.src} target="_blank" rel="noreferrer noopener">
                          {img.src.split("/").pop() || img.src}
                        </a>
                      </td>
                      <td>
                        {img.alt === null ? (
                          <span className="obs obs-error">missing</span>
                        ) : img.alt === "" ? (
                          <span className="muted">decorative</span>
                        ) : (
                          img.alt
                        )}
                      </td>
                      <td className={img.width === null ? "obs obs-warn" : ""}>{img.width ?? "—"}</td>
                      <td className={img.height === null ? "obs obs-warn" : ""}>{img.height ?? "—"}</td>
                      <td>{img.loading === "lazy" ? "yes" : "no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ShowMore
              shown={IMAGE_PREVIEW}
              total={images.length}
              open={!!openSections.images}
              onToggle={() => toggle("images")}
            />
          </>
        )}
      </section>

      {/* ---- Structured data ---- */}
      <section className="detail-section">
        <h4 className="detail-heading">Structured data ({schemaChecks.length})</h4>
        {schemaChecks.length === 0 ? (
          <Note observation={{ severity: "warn", message: "No JSON-LD structured data found." }} />
        ) : (
          <ul className="schema-list">
            {schemaChecks.map((s, i) => (
              <li key={i}>
                <span className={`schema-chip${s.valid ? "" : " schema-chip-invalid"}`}>{s.type}</span>
                {s.valid ? (
                  <span className="obs obs-ok">valid</span>
                ) : (
                  <span className="schema-issues">
                    {s.issues.map((issue, j) => (
                      <span key={j} className="obs obs-error">
                        {issue}
                      </span>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- JavaScript / API ---- */}
      <section className="detail-section">
        <h4 className="detail-heading">JavaScript &amp; APIs</h4>
        <div className="page-detail-grid">
          <Field label="Total scripts" value={String(page.scriptCount ?? 0)} />
          <Field label="Inline blocks" value={String(page.inlineScriptCount ?? 0)} />
          <Field label="Render-blocking" value={String(page.blockingScriptCount ?? 0)} />
          <Field label="Third-party origins" value={String((page.thirdPartyOrigins ?? []).length)} />
        </div>
        {(page.blockingScriptCount ?? 0) > 0 && (
          <Note
            observation={{
              severity: "warn",
              message: `${page.blockingScriptCount} render-blocking script(s) — neither async nor defer.`,
            }}
          />
        )}
        {(page.thirdPartyOrigins ?? []).length > 0 && (
          <div className="structured-data-chips">
            {(page.thirdPartyOrigins ?? []).map((origin) => (
              <span key={origin} className="origin-chip">
                {origin}
              </span>
            ))}
          </div>
        )}
        {scripts.length > 0 && (
          <>
            <ul className="page-detail-links script-list">
              {(openSections.scripts ? scripts : scripts.slice(0, SCRIPT_PREVIEW)).map((s, i) => (
                <li key={i}>
                  <span className="link-target">
                    {s.src ? s.src : <em>inline ({s.inlineBytes} B)</em>}
                  </span>
                  {s.async && <span className="flag-chip">async</span>}
                  {s.defer && <span className="flag-chip">defer</span>}
                  {s.module && <span className="flag-chip">module</span>}
                  {s.src && !s.async && !s.defer && !s.module && (
                    <span className="flag-chip flag-chip-warning">blocking</span>
                  )}
                </li>
              ))}
            </ul>
            <ShowMore
              shown={SCRIPT_PREVIEW}
              total={scripts.length}
              open={!!openSections.scripts}
              onToggle={() => toggle("scripts")}
            />
          </>
        )}
      </section>

      {/* ---- Links ---- */}
      {(internalLinks.length > 0 || externalLinks.length > 0) && (
        <section className="detail-section">
          <h4 className="detail-heading">
            Links — {page.internalLinkCount ?? 0} internal, {page.externalLinkCount ?? 0} external
          </h4>
          {internalLinks.length > 0 && (
            <>
              <span className="page-detail-label">Internal ({internalLinks.length} unique)</span>
              <ul className="page-detail-links">
                {(openSections.internal ? internalLinks : internalLinks.slice(0, LINK_PREVIEW)).map((l, i) => (
                  <li key={i}>
                    <span className="link-anchor">{l.anchor || <em>no anchor text</em>}</span>
                    <span className="muted link-target">{l.url}</span>
                    {l.count > 1 && <span className="link-count">×{l.count}</span>}
                    {l.nofollow && <span className="flag-chip flag-chip-warning">nofollow</span>}
                  </li>
                ))}
              </ul>
              <ShowMore
                shown={LINK_PREVIEW}
                total={internalLinks.length}
                open={!!openSections.internal}
                onToggle={() => toggle("internal")}
              />
            </>
          )}
          {externalLinks.length > 0 && (
            <>
              <span className="page-detail-label">External ({externalLinks.length} unique)</span>
              <ul className="page-detail-links">
                {(openSections.external ? externalLinks : externalLinks.slice(0, LINK_PREVIEW)).map((l, i) => (
                  <li key={i}>
                    <span className="link-anchor">{l.anchor || <em>no anchor text</em>}</span>
                    <span className="muted link-target">{l.url}</span>
                    {l.count > 1 && <span className="link-count">×{l.count}</span>}
                    {l.nofollow && <span className="flag-chip flag-chip-warning">nofollow</span>}
                  </li>
                ))}
              </ul>
              <ShowMore
                shown={LINK_PREVIEW}
                total={externalLinks.length}
                open={!!openSections.external}
                onToggle={() => toggle("external")}
              />
            </>
          )}
        </section>
      )}

      {/* ---- Social ---- */}
      {ogEntries.length > 0 && (
        <section className="detail-section">
          <h4 className="detail-heading">Social / Open Graph ({ogEntries.length})</h4>
          <ul className="page-detail-og">
            {ogEntries.map(([key, value]) => (
              <li key={key}>
                <span className="og-key">{key}</span>
                <span className="og-value">{value}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {page.hreflang && page.hreflang.length > 0 && (
        <section className="detail-section">
          <h4 className="detail-heading">Hreflang ({page.hreflang.length})</h4>
          <div className="structured-data-chips">
            {page.hreflang.map((h, i) => (
              <span key={i} className="structured-data-chip" title={h.href}>
                {h.lang}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* ---- Content ---- */}
      {content && (
        <section className="detail-section">
          <h4 className="detail-heading">Page content ({content.length.toLocaleString()} chars stored)</h4>
          <p className="page-content-preview">
            {openSections.content ? content : content.slice(0, CONTENT_PREVIEW_CHARS)}
            {!openSections.content && content.length > CONTENT_PREVIEW_CHARS && "…"}
          </p>
          {content.length > CONTENT_PREVIEW_CHARS && (
            <button type="button" className="show-more-button" onClick={() => toggle("content")}>
              {openSections.content ? "Show less" : "Show full content"}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="page-detail-field">
      <span className="page-detail-label">{label}</span>
      <p className={mono ? "page-detail-mono" : undefined}>{value}</p>
    </div>
  );
}
