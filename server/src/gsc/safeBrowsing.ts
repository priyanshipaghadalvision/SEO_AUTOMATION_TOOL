import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { securityChecks, websites } from "../db/schema.js";

/**
 * Safe Browsing v4 site check.
 *
 * Google exposes no API for Search Console's manual actions or security
 * issues, so this is the closest automatable signal: is any of the site's
 * URLs on Google's threat lists right now. It needs a GOOGLE_API_KEY; the
 * honest answer without one is "unavailable", stored as such so the UI never
 * shows an unchecked site as safe.
 */

const SAFE_BROWSING_ENDPOINT = "https://safebrowsing.googleapis.com/v4/threatMatches:find";

/** Beyond the homepage, how many crawled pages a check submits. */
const MAX_EXTRA_PAGES = 20;

export interface ThreatRow {
  threatType: string;
  url: string;
}

export interface SecurityStatus {
  status: "clean" | "flagged" | "unavailable";
  threats: ThreatRow[];
  checkedAt: string;
}

interface ThreatMatch {
  threatType?: string;
  threat?: { url?: string };
}

/**
 * Checks the site's key URLs against Safe Browsing and upserts the verdict.
 *
 * One current status per website (unique on website_id) -- this answers "is
 * the site flagged right now", so a re-check replaces rather than appends.
 * Without an API key it records "unavailable" WITHOUT any network call:
 * Safe Browsing rejects keyless requests, and pretending to check would be
 * worse than admitting we can't.
 */
export async function checkSite(websiteId: string): Promise<SecurityStatus> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return upsertStatus(websiteId, "unavailable", []);

  const entries = await selectEntryUrls(websiteId);

  const res = await fetch(`${SAFE_BROWSING_ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // The top-level client object is REQUIRED -- Google 400s without it.
      client: { clientId: "seo-automation", clientVersion: "1.0.0" },
      threatInfo: {
        threatTypes: [
          "MALWARE",
          "SOCIAL_ENGINEERING",
          "UNWANTED_SOFTWARE",
          "POTENTIALLY_HARMFUL_APPLICATION",
        ],
        platformTypes: ["ANY_PLATFORM"],
        threatEntryTypes: ["URL"],
        threatEntries: entries.map((url) => ({ url })),
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Safe Browsing returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }

  // A site with no matches gets `{}` back, not an empty array.
  const json = (await res.json()) as { matches?: ThreatMatch[] };
  const threats: ThreatRow[] = (json.matches ?? []).flatMap((m) =>
    m.threatType && m.threat?.url ? [{ threatType: m.threatType, url: m.threat.url }] : [],
  );

  return upsertStatus(websiteId, threats.length > 0 ? "flagged" : "clean", threats);
}

/** The stored verdict, or null when no check has ever run for the site. */
export async function getSecurityStatus(websiteId: string): Promise<SecurityStatus | null> {
  const [row] = await db
    .select()
    .from(securityChecks)
    .where(eq(securityChecks.websiteId, websiteId));
  if (!row) return null;

  return {
    status: row.status as SecurityStatus["status"],
    threats: row.threats ?? [],
    checkedAt: row.checkedAt.toISOString(),
  };
}

async function upsertStatus(
  websiteId: string,
  status: SecurityStatus["status"],
  threats: ThreatRow[],
): Promise<SecurityStatus> {
  const checkedAt = new Date();
  await db
    .insert(securityChecks)
    .values({ websiteId, status, threats, checkedAt })
    .onConflictDoUpdate({
      target: [securityChecks.websiteId],
      set: { status, threats, checkedAt },
    });
  return { status, threats, checkedAt: checkedAt.toISOString() };
}

/**
 * Homepage plus the most-linked crawled pages, deduplicated.
 *
 * Safe Browsing matches whole URL prefixes, so the homepage alone catches a
 * site-wide flag; the extra pages catch the common hacked-site pattern where
 * only injected deep pages are listed.
 */
async function selectEntryUrls(websiteId: string): Promise<string[]> {
  const [site] = await db
    .select({ originalUrl: websites.originalUrl })
    .from(websites)
    .where(eq(websites.id, websiteId));
  if (!site) throw new Error("Website not found.");

  const urls = new Set<string>([site.originalUrl]);

  const { rows } = await db.execute<{ url: string }>(sql`
    SELECT coalesce(p.final_url, p.url) AS url
    FROM pages p
    WHERE p.crawl_id = (
      SELECT c.id FROM crawls c
      WHERE c.website_id = ${websiteId} AND c.status = 'COMPLETED'
      ORDER BY c.started_at DESC NULLS LAST, c.id
      LIMIT 1
    )
      AND p.http_status = 200
    ORDER BY p.inbound_link_count DESC NULLS LAST, p.id
    LIMIT ${MAX_EXTRA_PAGES}
  `);
  for (const r of rows) urls.add(r.url);

  return [...urls];
}
