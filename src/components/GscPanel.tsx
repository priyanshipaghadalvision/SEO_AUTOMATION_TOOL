import { useCallback, useEffect, useMemo, useState } from "react";
import type { GscProperty, GscStatus, GscSyncResult, Website } from "../api/client";
import {
  disconnectGsc,
  getGscAuthUrl,
  getGscProperties,
  getGscStatus,
  linkGscProperty,
  syncGscMetrics,
  unlinkGscProperty,
} from "../api/client";
import { SpinnerIcon } from "./icons";
import { GscDataModal } from "./GscDataModal";
import "./GscPanel.css";

/** Messages the OAuth callback appends to the app URL on its way back. */
const CALLBACK_MESSAGES: Record<string, { text: string; tone: "ok" | "warn" }> = {
  connected: { text: "Search Console connected.", tone: "ok" },
  denied: { text: "You declined the Google consent screen — nothing was connected.", tone: "warn" },
  invalid_state: {
    text: "That sign-in link had expired or didn't match this session. Start the connection again.",
    tone: "warn",
  },
  failed: {
    text: "Google rejected the connection. Check the redirect URI registered on your OAuth client matches exactly.",
    tone: "warn",
  },
};

export function GscPanel({ websites }: { websites: Website[] }) {
  const [status, setStatus] = useState<GscStatus | null>(null);
  const [properties, setProperties] = useState<GscProperty[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<GscSyncResult | null>(null);
  const [callback, setCallback] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const [viewing, setViewing] = useState<{ websiteId: string; domain: string } | null>(null);

  // The OAuth callback redirects here with ?gsc=<outcome>. Read it once, then
  // strip it from the URL so a refresh doesn't replay a stale banner.
  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get("gsc");
    if (!outcome) return;
    setCallback(CALLBACK_MESSAGES[outcome] ?? null);
    const url = new URL(window.location.href);
    url.searchParams.delete("gsc");
    window.history.replaceState({}, "", url.toString());
  }, []);

  const refresh = useCallback(async () => {
    const next = await getGscStatus();
    setStatus(next);
    // Properties need a live Google call, so only ask once connected.
    setProperties(next.connected ? (await getGscProperties()).properties : []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getGscStatus()
      .then(async (next) => {
        if (cancelled) return;
        setStatus(next);
        if (next.connected) {
          const { properties: list } = await getGscProperties();
          if (!cancelled) setProperties(list);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load Search Console status.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
      // A dead grant leaves the connection row in place but useless. Re-read
      // status so the panel can offer Connect again rather than showing
      // actions that will keep failing.
      if (/invalidated this connection/i.test(message)) {
        await refresh().catch(() => undefined);
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleConnect() {
    await run("connect", async () => {
      const { authUrl } = await getGscAuthUrl();
      // Full navigation, not a popup: Google blocks its consent screen in
      // many embedded contexts, and a redirect works everywhere.
      window.location.href = authUrl;
    });
  }

  const websiteName = useMemo(
    () => new Map(websites.map((w) => [w.id, w.domain])),
    [websites],
  );

  if (loading) return null;

  if (!status?.configured) {
    return (
      <section className="card gsc-card">
        <div className="card-header-row">
          <h2>Google Search Console</h2>
        </div>
        <p className="muted small">
          Not configured. {status?.setupHint} Once connected, every issue and proposed fix can be ranked by the
          traffic the page actually gets.
        </p>
      </section>
    );
  }

  return (
    <section className="card gsc-card">
      <div className="card-header-row">
        <h2>Google Search Console</h2>
        {status.connected && (
          <div className="gsc-account">
            <span className="gsc-dot" />
            <span className="muted small">{status.connection?.googleEmail ?? "connected"}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy !== null}
              onClick={() =>
                run("disconnect", async () => {
                  await disconnectGsc();
                  await refresh();
                })
              }
            >
              Disconnect
            </button>
          </div>
        )}
      </div>

      {callback && <p className={`small ${callback.tone === "ok" ? "gsc-ok" : "gsc-warn"}`}>{callback.text}</p>}
      {error && <p className="error-text">{error}</p>}

      {!status.connected && (
        <div className="gsc-connect">
          <p className="muted small">
            Connect a Google account to pull clicks, impressions, CTR and average position for every crawled URL.
            Read-only — this can never change anything in your Search Console.
          </p>
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={handleConnect}>
            {busy === "connect" ? (
              <>
                <SpinnerIcon /> Opening Google&hellip;
              </>
            ) : (
              "Connect Search Console"
            )}
          </button>
        </div>
      )}

      {status.connected && properties.length === 0 && (
        <p className="muted small">
          This Google account has no Search Console properties. Verify the site at{" "}
          <a href="https://search.google.com/search-console" target="_blank" rel="noreferrer noopener">
            search.google.com/search-console
          </a>{" "}
          first, then reload.
        </p>
      )}

      {status.connected && properties.length > 0 && (
        <table className="gsc-table">
          <thead>
            <tr>
              <th>Property</th>
              <th>Type</th>
              <th>Linked website</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {properties.map((p) => (
              <PropertyRow
                key={p.siteUrl}
                property={p}
                websites={websites}
                websiteName={websiteName}
                busy={busy}
                onLink={(websiteId) =>
                  run(`link:${p.siteUrl}`, async () => {
                    await linkGscProperty(websiteId, p.siteUrl);
                    await refresh();
                  })
                }
                onUnlink={(websiteId) =>
                  run(`link:${p.siteUrl}`, async () => {
                    await unlinkGscProperty(websiteId);
                    await refresh();
                  })
                }
                onSync={(websiteId) =>
                  run(`sync:${p.siteUrl}`, async () => {
                    setSync(await syncGscMetrics(websiteId));
                  })
                }
                onView={(websiteId) =>
                  setViewing({ websiteId, domain: websiteName.get(websiteId) ?? p.siteUrl })
                }
              />
            ))}
          </tbody>
        </table>
      )}

      {viewing && (
        <GscDataModal
          websiteId={viewing.websiteId}
          domain={viewing.domain}
          onClose={() => setViewing(null)}
        />
      )}

      {sync && (
        <p className="small gsc-ok">
          Synced <strong>{sync.siteUrl}</strong>: {sync.rowsWritten.toLocaleString()} daily rows across{" "}
          {sync.pages.toLocaleString()} pages ({sync.startDate} to {sync.endDate}) —{" "}
          {sync.totalClicks.toLocaleString()} clicks, {sync.totalImpressions.toLocaleString()} impressions.
        </p>
      )}
    </section>
  );
}

function PropertyRow({
  property,
  websites,
  websiteName,
  busy,
  onLink,
  onUnlink,
  onSync,
  onView,
}: {
  property: GscProperty;
  websites: Website[];
  websiteName: Map<string, string>;
  busy: string | null;
  onLink: (websiteId: string) => void;
  onUnlink: (websiteId: string) => void;
  onSync: (websiteId: string) => void;
  onView: (websiteId: string) => void;
}) {
  // Domain matches first: on an account with dozens of properties the right
  // one should not need hunting for.
  const options = useMemo(() => {
    const suggested = new Set(property.suggestedWebsiteIds);
    return [...websites].sort((a, b) => Number(suggested.has(b.id)) - Number(suggested.has(a.id)));
  }, [websites, property.suggestedWebsiteIds]);

  const linked = property.linkedWebsiteId;
  const rowBusy = busy === `link:${property.siteUrl}` || busy === `sync:${property.siteUrl}`;

  return (
    <tr>
      <td className="gsc-site-url" title={property.siteUrl}>
        {property.siteUrl}
      </td>
      <td>
        <span className="flag-chip gsc-type-chip">
          {property.propertyType === "domain" ? "domain" : "url prefix"}
        </span>
      </td>
      <td>
        {/* A linked website that isn't in the list can happen when the link
            outlives the site; showing the raw id would be meaningless, so
            fall back to the property's own name. */}
        {!property.canReadData ? (
          // Listed by Google but never verified: linking it would succeed and
          // then 403 on every sync, so say why instead of offering the option.
          <span
            className="gsc-unverified"
            title="Google lists this property for your account, but ownership was never verified, so it returns no data. Verify it in Search Console first."
          >
            not verified — no data
          </span>
        ) : linked ? (
          <span className="gsc-linked">{websiteName.get(linked) ?? property.siteUrl}</span>
        ) : (
          <select
            className="gsc-select"
            defaultValue=""
            disabled={rowBusy}
            onChange={(e) => e.target.value && onLink(e.target.value)}
          >
            <option value="">Link to&hellip;</option>
            {options.map((w) => (
              <option key={w.id} value={w.id}>
                {w.domain}
                {property.suggestedWebsiteIds.includes(w.id) ? "  (match)" : ""}
              </option>
            ))}
          </select>
        )}
      </td>
      <td className="gsc-row-actions">
        {linked && (
          <>
            <button type="button" className="btn btn-ghost btn-sm" disabled={rowBusy} onClick={() => onView(linked)}>
              View data
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={rowBusy} onClick={() => onSync(linked)}>
              {busy === `sync:${property.siteUrl}` ? (
                <>
                  <SpinnerIcon /> Syncing&hellip;
                </>
              ) : (
                "Sync"
              )}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={rowBusy} onClick={() => onUnlink(linked)}>
              Unlink
            </button>
          </>
        )}
      </td>
    </tr>
  );
}
