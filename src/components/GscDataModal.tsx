import { useEffect, useState } from "react";
import { GSC_TABS, GscDataPanel } from "./GscDataPanel";
import type { GscTab } from "./GscDataPanel";
import "./Modal.css";

/**
 * The dashboard's quick look at Search Console.
 *
 * This is shell only -- backdrop, close button, tab strip. Every number it
 * shows comes from GscDataPanel, the same component the site page renders, so
 * the two views cannot disagree.
 */
export function GscDataModal({
  websiteId,
  domain,
  onClose,
}: {
  websiteId: string;
  domain: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<GscTab>("overview");

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Search Console data for ${domain}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h3>Search Console</h3>
            <p className="muted small">{domain}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="modal-tabs" role="tablist">
          {GSC_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`modal-tab${tab === t.key ? " modal-tab-active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          <GscDataPanel websiteId={websiteId} domain={domain} tab={tab} />
        </div>
      </div>
    </div>
  );
}
