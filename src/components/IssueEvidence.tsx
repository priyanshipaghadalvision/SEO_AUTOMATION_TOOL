import { useState } from "react";
import type { Issue, Page } from "../api/client";
import { getPage } from "../api/client";

/**
 * Renders the concrete evidence behind an issue.
 *
 * The analysis engine already records why each rule fired; this turns that
 * payload into the specific thing a developer needs to act -- which link is
 * broken, which image has no alt, what the offending title actually says --
 * instead of only naming the page it happened on.
 *
 * Each rule family gets the shape that suits it. Head-only tags (title,
 * description, canonical) show their value, because they are invisible in
 * the rendered page and the value IS the evidence. Body elements also carry
 * a selector and the element's opening tag, which is what someone greps for
 * in source.
 */
export function IssueEvidence({ issue }: { issue: Issue }) {
  const d = issue.detail;
  if (!d) return null;

  switch (issue.type) {
    case "links.broken_internal":
      return <BrokenLinks targets={asArray<BrokenTarget>(d.targets)} total={asNumber(d.count)} />;

    case "image.alt_missing":
    case "image.dimensions_missing":
      return (
        <ImageEvidence
          examples={toImageExamples(d.examples)}
          total={asNumber(d.count)}
          issue={issue}
          rule={issue.type}
        />
      );

    case "heading.hierarchy_skip":
      return <HeadingSkips skips={toHeadingSkips(d.skips)} />;

    case "heading.h1_multiple":
      return <ElementList items={toLabelledElements(d.headings)} />;

    case "title.too_short":
    case "title.too_long":
      return (
        <ValueEvidence
          label="Current title"
          value={asString(d.title)}
          length={asNumber(d.length)}
          issue={issue}
          field="title"
        />
      );

    case "description.too_short":
    case "description.too_long":
      return (
        <ValueEvidence
          label="Current description"
          value={asString(d.value)}
          length={asNumber(d.length)}
          issue={issue}
          field="metaDescription"
        />
      );

    case "canonical.not_self":
      return (
        <dl className="ev-rows">
          <Row label="Canonical points to" value={asString(d.canonical)} mono />
          <Row label="This page is" value={asString(d.pageUrl)} mono />
        </dl>
      );

    case "http.redirect_chain":
    case "http.redirect_loop":
      return <RedirectChain chain={asArray<string>(d.chain)} />;

    case "title.duplicate":
    case "description.duplicate":
    case "content.duplicate":
      return <DuplicateGroup value={asString(d.value)} urls={asArray<string>(d.urls)} total={asNumber(d.count)} />;

    case "links.excessive":
    case "links.weakly_linked":
    case "content.thin":
    case "perf.slow_response":
    case "perf.large_html":
    case "perf.render_blocking_js":
    case "schema.invalid":
      return <MetricEvidence detail={d} />;

    case "site.sitemap_missing":
      return <UrlList label="Checked" urls={asArray<string>(d.checked)} />;

    case "site.robots_missing":
      return (
        <dl className="ev-rows">
          <Row label="URL" value={asString(d.url)} mono />
          <Row label="Status" value={d.status === null ? "no response" : String(d.status)} />
        </dl>
      );

    default:
      return null;
  }
}

/* ---------- shapes ---------- */

interface BrokenTarget {
  url: string;
  status: number;
  anchor: string | null;
  selector: string | null;
  snippet: string | null;
  occurrences: number;
}

interface ImageExample {
  src: string;
  selector: string | null;
  snippet?: string | null;
  width?: number | null;
  height?: number | null;
}

interface HeadingSkip {
  gap: string;
  /** Null on issues analysed before the surrounding text was recorded. */
  after: string | null;
  before: string | null;
  selector: string | null;
}

/* ---------- renderers ---------- */

function BrokenLinks({ targets, total }: { targets: BrokenTarget[]; total: number }) {
  if (targets.length === 0) return null;
  return (
    <div className="ev-block">
      <table className="ev-table">
        <thead>
          <tr>
            <th>Anchor text</th>
            <th>Broken target</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {targets.map((t, i) => (
            <tr key={i}>
              <td>{t.anchor ? `"${t.anchor}"` : <em className="muted">no anchor text</em>}</td>
              <td className="ev-mono ev-break">
                {t.url}
                {t.occurrences > 1 && <span className="link-count"> ×{t.occurrences}</span>}
              </td>
              <td>
                <span className="http-badge http-badge-error">{t.status || "ERR"}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {targets.map((t, i) =>
        t.snippet || t.selector ? <Locator key={`loc-${i}`} selector={t.selector} snippet={t.snippet} /> : null,
      )}
      {total > targets.length && <p className="muted small">+{total - targets.length} more on this page</p>}
    </div>
  );
}

/**
 * Only a handful of examples are stored per issue -- keeping every offending
 * image on every issue row would duplicate data the page record already
 * holds. "Show all" therefore fetches that page on demand and re-applies the
 * rule, so the full list is exact and costs nothing until asked for.
 */
function ImageEvidence({
  examples,
  total,
  issue,
  rule,
}: {
  examples: ImageExample[];
  total: number;
  issue: Issue;
  rule: string;
}) {
  const [all, setAll] = useState<ImageExample[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  async function showAll() {
    if (!issue.pageId) return;
    setLoading(true);
    setFailed(false);
    try {
      const { page } = await getPage(issue.crawlId, issue.pageId);
      setAll(offendingImages(page, rule));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  const shown = all ?? examples;
  if (shown.length === 0) return null;
  const hiddenCount = total - shown.length;

  return (
    <div className="ev-block">
      <ul className="ev-list">
        {shown.map((img, i) => (
          <li key={i}>
            <a href={img.src} target="_blank" rel="noreferrer noopener" className="ev-mono ev-break">
              {img.src}
            </a>
            {(img.width !== null || img.height !== null) && (img.width === null || img.height === null) && (
              <span className="muted small">
                {" "}
                (w:{img.width ?? "—"} h:{img.height ?? "—"})
              </span>
            )}
            <Locator selector={img.selector} snippet={img.snippet ?? null} />
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button type="button" className="show-more-button" onClick={showAll} disabled={loading || !issue.pageId}>
          {loading ? "Loading…" : `Show all ${total} on this page`}
        </button>
      )}
      {all && <button type="button" className="show-more-button" onClick={() => setAll(null)}>Show less</button>}
      {failed && <p className="error-text small">Could not load the full list.</p>}
    </div>
  );
}

/** Re-applies the image rule to a full page record. */
function offendingImages(page: Page, rule: string): ImageExample[] {
  const images = page.images ?? [];
  const matched =
    rule === "image.alt_missing"
      ? images.filter((i) => i.alt === null)
      : images.filter((i) => i.width === null || i.height === null);

  return matched.map((i) => ({
    src: i.src,
    selector: i.selector ?? null,
    snippet: i.snippet ?? null,
    width: i.width,
    height: i.height,
  }));
}

function HeadingSkips({ skips }: { skips: HeadingSkip[] }) {
  if (skips.length === 0) return null;
  return (
    <div className="ev-block">
      <ul className="ev-list">
        {skips.map((s, i) => (
          <li key={i}>
            <span className="ev-gap">{s.gap}</span>
            {/* Older issues recorded only the level gap; showing empty quotes
                for the missing text reads as a bug rather than as absent data. */}
            {s.after && s.before && (
              <>
                {" "}
                after <strong>“{s.after}”</strong> → <strong>“{s.before}”</strong>
              </>
            )}
            <Locator selector={s.selector} snippet={null} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ElementList({ items }: { items: Array<{ label: string; selector: string | null }> }) {
  if (items.length === 0) return null;
  return (
    <div className="ev-block">
      <ul className="ev-list">
        {items.map((it, i) => (
          <li key={i}>
            <strong>“{it.label}”</strong>
            <Locator selector={it.selector} snippet={null} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Shows the offending value, recovering it from the page record when the
 * stored evidence predates it.
 *
 * Fetched on demand rather than eagerly: a list of 80 over-long descriptions
 * would otherwise fire 80 requests on expand. Re-analysing the crawl bakes
 * the value into the issue and removes the need for this path entirely.
 */
function ValueEvidence({
  label,
  value,
  length,
  issue,
  field,
}: {
  label: string;
  value: string | null;
  length: number;
  issue: Issue;
  field: "title" | "metaDescription";
}) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const shown = value ?? loaded;

  async function load() {
    if (!issue.pageId) return;
    setLoading(true);
    setFailed(false);
    try {
      const { page } = await getPage(issue.crawlId, issue.pageId);
      const v = page[field];
      if (v) setLoaded(v);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  if (!shown) {
    if (!issue.pageId) return null;
    return (
      <div className="ev-block">
        <button type="button" className="show-more-button" onClick={load} disabled={loading}>
          {loading ? "Loading…" : `Show current ${field === "title" ? "title" : "description"}`}
        </button>
        {failed && <p className="error-text small">Value unavailable — re-analyse the crawl.</p>}
      </div>
    );
  }

  return (
    <div className="ev-block">
      <span className="page-detail-label">
        {label} — {length || shown.length} chars
      </span>
      <p className="ev-value">{shown}</p>
    </div>
  );
}

function RedirectChain({ chain }: { chain: string[] }) {
  if (chain.length === 0) return null;
  return (
    <div className="ev-block">
      <ol className="ev-chain">
        {chain.map((u, i) => (
          <li key={i} className="ev-mono ev-break">
            {u}
          </li>
        ))}
      </ol>
    </div>
  );
}

function DuplicateGroup({ value, urls, total }: { value: string | null; urls: string[]; total: number }) {
  return (
    <div className="ev-block">
      {value && <p className="ev-value">{value}</p>}
      <span className="page-detail-label">Shared by {total} URLs</span>
      <ul className="ev-list">
        {urls.map((u, i) => (
          <li key={i}>
            <a href={u} target="_blank" rel="noreferrer noopener" className="ev-mono ev-break">
              {u}
            </a>
          </li>
        ))}
      </ul>
      {total > urls.length && <p className="muted small">+{total - urls.length} more</p>}
    </div>
  );
}

function UrlList({ label, urls }: { label: string; urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <div className="ev-block">
      <span className="page-detail-label">{label}</span>
      <ul className="ev-list">
        {urls.map((u, i) => (
          <li key={i} className="ev-mono ev-break">
            {u}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Fallback for numeric rules: shows whatever scalars the rule recorded. */
function MetricEvidence({ detail }: { detail: Record<string, unknown> }) {
  const rows = Object.entries(detail).filter(
    ([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean",
  );
  if (rows.length === 0) return null;
  return (
    <dl className="ev-rows">
      {rows.map(([k, v]) => (
        <Row key={k} label={humanKey(k)} value={String(v)} />
      ))}
    </dl>
  );
}

function Row({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  if (value === null) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? "ev-mono ev-break" : undefined}>{value}</dd>
    </div>
  );
}

/** Selector + opening tag: the "where in the markup" pair. */
function Locator({ selector, snippet }: { selector: string | null; snippet: string | null }) {
  if (!selector && !snippet) return null;
  return (
    <div className="ev-locator">
      {snippet && <code className="ev-snippet">{snippet}</code>}
      {selector && <code className="ev-selector">{selector}</code>}
    </div>
  );
}

/* ---------- helpers ---------- */

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * `detail` is schemaless JSON written by whichever version of the rules ran,
 * and issue rows outlive rule changes -- a crawl analysed last week still
 * holds last week's shape until it is re-analysed.
 *
 * These normalisers accept every shape a rule has emitted (an earlier
 * version stored plain strings; the current one stores objects with
 * locators) and drop anything without a usable value. That last part
 * matters: without it a shape mismatch renders a list of blank rows, which
 * looks like the analyser found nothing rather than like stale data.
 */
function toImageExamples(value: unknown): ImageExample[] {
  return asArray<unknown>(value)
    .map((entry): ImageExample | null => {
      if (typeof entry === "string") return { src: entry, selector: null };
      if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        const src = asString(o.src);
        if (!src) return null;
        return {
          src,
          selector: asString(o.selector),
          snippet: asString(o.snippet),
          width: typeof o.width === "number" ? o.width : null,
          height: typeof o.height === "number" ? o.height : null,
        };
      }
      return null;
    })
    .filter((x): x is ImageExample => x !== null);
}

function toHeadingSkips(value: unknown): HeadingSkip[] {
  return asArray<unknown>(value)
    .map((entry): HeadingSkip | null => {
      // Earlier versions stored just the level gap, e.g. "H2→H4".
      if (typeof entry === "string") return entry ? { gap: entry, after: null, before: null, selector: null } : null;
      if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        const gap = asString(o.gap);
        if (!gap) return null;
        return { gap, after: asString(o.after), before: asString(o.before), selector: asString(o.selector) };
      }
      return null;
    })
    .filter((x): x is HeadingSkip => x !== null);
}

function toLabelledElements(value: unknown): Array<{ label: string; selector: string | null }> {
  return asArray<unknown>(value)
    .map((entry) => {
      if (typeof entry === "string") return entry ? { label: entry, selector: null } : null;
      if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        const label = asString(o.text) ?? asString(o.label);
        if (!label) return null;
        return { label, selector: asString(o.selector) };
      }
      return null;
    })
    .filter((x): x is { label: string; selector: string | null } => x !== null);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function humanKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}
