import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { gscProperties, gscSitemaps, websites } from "../db/schema.js";
import { apiFetch } from "./client.js";

/** The wire shape the app exposes; timestamps as ISO strings for JSON. */
export interface SitemapRow {
  path: string;
  lastSubmitted: string | null;
  lastDownloaded: string | null;
  isPending: boolean;
  isSitemapsIndex: boolean;
  warnings: number;
  errors: number;
  contents: Array<{ type: string; submitted: number; indexed: number }>;
}

/**
 * `sitemaps.list` as Google actually sends it. The numeric-looking fields
 * (`warnings`, `errors`, `submitted`, `indexed`) arrive as STRINGS -- the API
 * declares them int64, which Google's JSON encoding always serialises as
 * text. `Number(...) || 0` coerces them and treats absent/garbage as zero.
 */
interface ApiSitemap {
  path?: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  warnings?: string;
  errors?: string;
  contents?: Array<{ type?: string; submitted?: string; indexed?: string }>;
}

/**
 * Pulls the sitemap list for one linked property and upserts it.
 *
 * Upsert per (propertyId, path); paths Google stops returning are kept
 * rather than deleted -- whether to show stale entries is a display
 * decision, not a storage one.
 */
export async function syncSitemaps(
  userId: string,
  websiteId: string,
): Promise<{ synced: number; sitemaps: SitemapRow[] }> {
  // Ownership is part of the query, not a separate check: a websiteId
  // belonging to another user simply matches no row.
  const [row] = await db
    .select({ property: gscProperties })
    .from(gscProperties)
    .innerJoin(websites, eq(websites.id, gscProperties.websiteId))
    .where(and(eq(gscProperties.websiteId, websiteId), eq(websites.userId, userId)));

  const property = row?.property;
  if (!property) throw new Error("No Search Console property is linked to this website.");

  const json = await apiFetch<{ sitemap?: ApiSitemap[] }>(
    userId,
    `/sites/${encodeURIComponent(property.siteUrl)}/sitemaps`,
  );

  // A path-less entry can't be keyed or upserted; drop it defensively.
  const entries = (json.sitemap ?? []).filter((s): s is ApiSitemap & { path: string } => Boolean(s.path));
  const fetchedAt = new Date();

  const values = entries.map((s) => ({
    propertyId: property.id,
    path: s.path,
    lastSubmitted: s.lastSubmitted ? new Date(s.lastSubmitted) : null,
    lastDownloaded: s.lastDownloaded ? new Date(s.lastDownloaded) : null,
    isPending: s.isPending ?? false,
    isSitemapsIndex: s.isSitemapsIndex ?? false,
    warnings: Number(s.warnings) || 0,
    errors: Number(s.errors) || 0,
    contents: (s.contents ?? []).map((c) => ({
      type: c.type ?? "web",
      submitted: Number(c.submitted) || 0,
      indexed: Number(c.indexed) || 0,
    })),
    fetchedAt,
  }));

  if (values.length > 0) {
    await db
      .insert(gscSitemaps)
      .values(values)
      .onConflictDoUpdate({
        target: [gscSitemaps.propertyId, gscSitemaps.path],
        set: {
          lastSubmitted: sql`excluded.last_submitted`,
          lastDownloaded: sql`excluded.last_downloaded`,
          isPending: sql`excluded.is_pending`,
          isSitemapsIndex: sql`excluded.is_sitemaps_index`,
          warnings: sql`excluded.warnings`,
          errors: sql`excluded.errors`,
          contents: sql`excluded.contents`,
          fetchedAt,
        },
      });
  }

  const sitemaps: SitemapRow[] = values.map((v) => ({
    path: v.path,
    lastSubmitted: v.lastSubmitted ? v.lastSubmitted.toISOString() : null,
    lastDownloaded: v.lastDownloaded ? v.lastDownloaded.toISOString() : null,
    isPending: v.isPending,
    isSitemapsIndex: v.isSitemapsIndex,
    warnings: v.warnings,
    errors: v.errors,
    contents: v.contents,
  }));

  return { synced: sitemaps.length, sitemaps };
}
