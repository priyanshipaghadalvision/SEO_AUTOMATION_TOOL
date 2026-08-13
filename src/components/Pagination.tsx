import "./Pagination.css";

/** Page sizes offered everywhere. 500 exists for "just show me a lot". */
export const PAGE_SIZES = [50, 100, 250, 500];

/**
 * Shared pager for every table in the app.
 *
 * Deliberately dumb: it reports the page you asked for and renders a window of
 * numbers. Whether that page is fetched from the server or sliced out of an
 * array already in memory is the caller's business, so the same control fits
 * a 10,000-row server query and a 3,378-row payload without either side
 * knowing about the other.
 */
export function Pagination({
  total,
  offset,
  pageSize,
  onChange,
  busy = false,
  noun = "row",
  plural,
}: {
  /** Rows matching the current filter, not rows on this page. */
  total: number;
  offset: number;
  pageSize: number;
  onChange: (next: { offset: number; pageSize: number }) => void;
  busy?: boolean;
  noun?: string;
  plural?: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.floor(offset / pageSize) + 1;
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + pageSize, total);
  const label = total === 1 ? noun : (plural ?? `${noun}s`);

  function go(nextPage: number) {
    const clamped = Math.min(pageCount, Math.max(1, nextPage));
    onChange({ offset: (clamped - 1) * pageSize, pageSize });
  }

  return (
    <div className="pager">
      <span className="muted small pager-range">
        {first.toLocaleString()}&ndash;{last.toLocaleString()} of {total.toLocaleString()} {label}
      </span>

      <div className="pager-controls">
        <button type="button" className="pager-btn" onClick={() => go(1)} disabled={busy || page === 1} aria-label="First page">
          &laquo;
        </button>
        <button type="button" className="pager-btn" onClick={() => go(page - 1)} disabled={busy || page === 1} aria-label="Previous page">
          &lsaquo;
        </button>

        {pageWindow(page, pageCount).map((p, i) =>
          p === null ? (
            <span key={`gap${i}`} className="pager-gap">
              &hellip;
            </span>
          ) : (
            <button
              key={p}
              type="button"
              aria-current={p === page}
              className={`pager-btn${p === page ? " pager-btn-active" : ""}`}
              onClick={() => go(p)}
              disabled={busy}
            >
              {p}
            </button>
          ),
        )}

        <button type="button" className="pager-btn" onClick={() => go(page + 1)} disabled={busy || page >= pageCount} aria-label="Next page">
          &rsaquo;
        </button>
        <button type="button" className="pager-btn" onClick={() => go(pageCount)} disabled={busy || page >= pageCount} aria-label="Last page">
          &raquo;
        </button>

        <select
          className="pager-size"
          value={pageSize}
          disabled={busy}
          aria-label="Rows per page"
          // Jump to the page holding the row you were already looking at,
          // rather than snapping back to the top of the table.
          onChange={(e) => {
            const size = Number(e.target.value);
            onChange({ offset: Math.floor(offset / size) * size, pageSize: size });
          }}
        >
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>
              {s} / page
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/**
 * Up to seven slots: first, last, the current page and its neighbours, with
 * nulls standing in for elided ranges. A 106-page table cannot render every
 * number, and a bare prev/next hides how far the list actually goes.
 */
function pageWindow(page: number, pageCount: number): Array<number | null> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);

  const out: Array<number | null> = [1];
  const from = Math.max(2, page - 1);
  const to = Math.min(pageCount - 1, page + 1);

  if (from > 2) out.push(null);
  for (let p = from; p <= to; p += 1) out.push(p);
  if (to < pageCount - 1) out.push(null);

  out.push(pageCount);
  return out;
}
