import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { crawls, issues, optimizations, pages, websites } from "../db/schema.js";
import { AI_SUPPORTED_ISSUES } from "./claudeProvider.js";
import { resolveProviders } from "./provider.js";
import { RULE_SUPPORTED_ISSUES } from "./ruleProvider.js";
import type {
  OptimizationDraft,
  OptimizationPageContext,
  OptimizationTask,
  SiteContext,
} from "./types.js";

/**
 * Pages sent to the AI provider in one run, unless overridden.
 *
 * A model call per page is the only part of this pipeline with a per-item
 * cost, so it is the only part that is capped. Whatever the cap drops is
 * reported back in the result rather than silently omitted -- a run that
 * covered 100 of 900 pages must not look like a run that covered everything.
 */
const DEFAULT_MAX_AI_PAGES = 100;

/** Indexable URLs sampled for the generated sitemap. */
const MAX_SAMPLE_URLS = 200;

export interface OptimizationRunResult extends Record<string, unknown> {
  /** Proposals stored after merging both providers and preserving reviews. */
  generated: number;
  bySource: { rule: number; ai: number };
  /** Auto-fixable issues neither provider could produce a concrete value for. */
  unhandledIssues: number;
  /** Proposals left untouched because a human had already approved/rejected them. */
  preservedReviews: number;
  aiEnabled: boolean;
  aiUnavailableReason: string | null;
  /** Pages the AI provider skipped because of the per-run cap. */
  aiPagesSkipped: number;
  /** Pages the AI provider attempted and errored on. */
  aiFailedPages: number;
  /** Why they failed, verbatim, so "0 AI fixes" is never unexplained. */
  aiError: string | null;
}

/**
 * Turns a crawl's auto-fixable issues into concrete, reviewable fixes.
 *
 * Two engines run over the same issue list. The rule engine handles anything
 * mechanically derivable and always runs; the AI engine handles the copy that
 * needs to know what a page is about, and runs only when a key is configured.
 * Where both answer the same issue, the AI result wins -- it saw the page
 * content, the rule engine only saw its shape.
 *
 * Nothing is applied to the live site. Every proposal lands as `pending` and
 * waits for a human, which is what keeps a medium-risk title rewrite from
 * shipping on a model's say-so.
 *
 * Re-runnable: pending proposals are regenerated wholesale, while anything a
 * user has already approved, rejected or applied is left exactly as it is.
 */
export async function generateOptimizations(crawlId: string): Promise<OptimizationRunResult> {
  const [row] = await db
    .select({ crawl: crawls, domain: websites.domain })
    .from(crawls)
    .innerJoin(websites, eq(websites.id, crawls.websiteId))
    .where(eq(crawls.id, crawlId));
  if (!row) throw new Error(`Crawl ${crawlId} not found`);

  const autoFixable = await db
    .select()
    .from(issues)
    .where(and(eq(issues.crawlId, crawlId), eq(issues.autoFixable, true)));

  if (autoFixable.length === 0) {
    const { aiUnavailableReason } = resolveProviders();
    return emptyResult(aiUnavailableReason);
  }

  const pageIds = [...new Set(autoFixable.map((i) => i.pageId).filter((id): id is string => id !== null))];
  const pageRows = pageIds.length > 0
    ? await db.select().from(pages).where(and(eq(pages.crawlId, crawlId), inArray(pages.id, pageIds)))
    : [];
  const pageById = new Map(pageRows.map((p) => [p.id, toPageContext(p)]));

  const site = await buildSiteContext(crawlId, row.domain);

  const tasks: OptimizationTask[] = autoFixable.map((issue) => ({
    issueType: issue.type,
    detail: issue.detail,
    page: issue.pageId ? pageById.get(issue.pageId) ?? null : null,
    site,
  }));

  const { rules, ai, aiUnavailableReason } = resolveProviders();

  // Rules first, and unconditionally: they cost nothing, and their output is
  // the floor the AI pass improves on rather than replaces.
  const ruleTasks = tasks.filter((t) => RULE_SUPPORTED_ISSUES.has(t.issueType));
  const { drafts: ruleDrafts } = await rules.generate(ruleTasks);

  let aiDrafts: OptimizationDraft[] = [];
  let aiPagesSkipped = 0;
  let aiFailedPages = 0;
  let aiError: string | null = null;

  if (ai) {
    const maxPages = Number(process.env.OPTIMIZER_MAX_PAGES) || DEFAULT_MAX_AI_PAGES;
    const candidates = tasks.filter((t) => t.page !== null && AI_SUPPORTED_ISSUES.has(t.issueType));
    const { kept, skippedPages } = capByPage(candidates, maxPages);
    aiPagesSkipped = skippedPages;
    if (skippedPages > 0) {
      console.warn(
        `[optimize] crawl ${crawlId}: AI pass capped at ${maxPages} pages; ${skippedPages} page(s) got rule-based fixes only. Raise OPTIMIZER_MAX_PAGES to cover more.`,
      );
    }
    const result = await ai.generate(kept);
    aiDrafts = result.drafts;
    aiFailedPages = result.failedPages;
    aiError = result.firstError;
  }

  const merged = mergeDrafts(ruleDrafts, aiDrafts);
  const { inserted, preserved } = await persist(crawlId, merged);

  const answered = new Set(merged.map((d) => `${d.pageId ?? "site"}|${d.issueType}`));
  const unhandled = autoFixable.filter((i) => !answered.has(`${i.pageId ?? "site"}|${i.type}`)).length;

  return {
    generated: inserted,
    bySource: {
      rule: merged.filter((d) => d.source === "rule").length,
      ai: merged.filter((d) => d.source === "ai").length,
    },
    unhandledIssues: unhandled,
    preservedReviews: preserved,
    aiEnabled: ai !== null,
    aiUnavailableReason,
    aiPagesSkipped,
    aiFailedPages,
    aiError,
  };
}

/**
 * Identity of a single proposal. Two drafts sharing this key are two attempts
 * at the same fix, not two different fixes.
 */
function dedupeKeyOf(draft: OptimizationDraft): string {
  return [draft.pageId ?? "site", draft.issueType, draft.action, draft.target ?? ""].join("|");
}

/** AI wins ties: it read the page copy, the rule engine only saw its shape. */
function mergeDrafts(ruleDrafts: OptimizationDraft[], aiDrafts: OptimizationDraft[]): OptimizationDraft[] {
  const byKey = new Map<string, OptimizationDraft>();
  for (const draft of ruleDrafts) byKey.set(dedupeKeyOf(draft), draft);
  for (const draft of aiDrafts) byKey.set(dedupeKeyOf(draft), draft);
  return [...byKey.values()];
}

/**
 * Writes proposals, keeping human decisions intact.
 *
 * Clearing only the `pending` rows and then inserting with ON CONFLICT DO
 * NOTHING gives both halves of what a re-run should do: stale pending
 * suggestions disappear, and a key someone has already approved or rejected
 * still occupies its slot, so the regenerated version cannot overwrite the
 * decision. Both statements share a transaction, so a failure mid-insert
 * cannot leave the crawl with its old proposals deleted and no new ones.
 */
async function persist(
  crawlId: string,
  drafts: OptimizationDraft[],
): Promise<{ inserted: number; preserved: number }> {
  return db.transaction(async (tx) => {
    const [{ preserved }] = await tx
      .select({ preserved: sql<number>`count(*)::int` })
      .from(optimizations)
      .where(and(eq(optimizations.crawlId, crawlId), sql`${optimizations.status} <> 'pending'`));

    await tx
      .delete(optimizations)
      .where(and(eq(optimizations.crawlId, crawlId), eq(optimizations.status, "pending")));

    let inserted = 0;
    // Chunked: Postgres caps a statement at 65535 bind parameters, and a
    // large crawl can easily produce thousands of alt-text proposals.
    const CHUNK = 500;
    for (let i = 0; i < drafts.length; i += CHUNK) {
      const values = drafts.slice(i, i + CHUNK).map((d) => ({
        crawlId,
        pageId: d.pageId,
        issueType: d.issueType,
        action: d.action,
        target: d.target,
        dedupeKey: dedupeKeyOf(d),
        oldValue: d.oldValue,
        newValue: d.newValue,
        reason: d.reason,
        confidence: d.confidence,
        risk: d.risk,
        source: d.source,
        model: d.model,
        url: d.url,
      }));
      const rows = await tx
        .insert(optimizations)
        .values(values)
        .onConflictDoNothing({ target: [optimizations.crawlId, optimizations.dedupeKey] })
        .returning({ id: optimizations.id });
      inserted += rows.length;
    }

    return { inserted, preserved: preserved ?? 0 };
  });
}

/**
 * Trims the AI workload to `maxPages` whole pages.
 *
 * Cutting on a page boundary rather than an issue boundary matters: a page's
 * title and description are generated in the same request so they agree with
 * each other, and half a page's issues would break that.
 */
function capByPage(
  tasks: OptimizationTask[],
  maxPages: number,
): { kept: OptimizationTask[]; skippedPages: number } {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    const id = task.page?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  if (order.length <= maxPages) return { kept: tasks, skippedPages: 0 };

  const allowed = new Set(order.slice(0, maxPages));
  return {
    kept: tasks.filter((t) => t.page && allowed.has(t.page.id)),
    skippedPages: order.length - maxPages,
  };
}

type PageRow = typeof pages.$inferSelect;

function toPageContext(row: PageRow): OptimizationPageContext {
  return {
    id: row.id,
    url: row.url,
    finalUrl: row.finalUrl,
    redirectChain: row.redirectChain,
    title: row.title,
    metaDescription: row.metaDescription,
    canonicalUrl: row.canonicalUrl,
    lang: row.lang,
    headings: row.headings ?? [],
    images: row.images ?? [],
    structuredData: row.structuredData ?? [],
    contentText: row.contentText,
    wordCount: row.wordCount ?? 0,
    scripts: row.scripts ?? [],
    blockingScriptCount: row.blockingScriptCount ?? 0,
  };
}

/**
 * Site-level facts the providers need: the brand domain, the real origin, and
 * a sample of indexable URLs for sitemap generation.
 *
 * The origin is read off a crawled page rather than assumed from the domain,
 * so a site served on http, or on www when the domain is bare, produces a
 * sitemap and robots.txt that match what is actually deployed.
 */
async function buildSiteContext(crawlId: string, domain: string): Promise<SiteContext> {
  const rows = await db
    .select({ url: pages.url, finalUrl: pages.finalUrl, depth: pages.depth })
    .from(pages)
    .where(
      and(
        eq(pages.crawlId, crawlId),
        sql`${pages.httpStatus} BETWEEN 200 AND 299`,
        sql`coalesce(${pages.noindex}, false) = false`,
      ),
    )
    .orderBy(pages.depth, pages.url)
    .limit(MAX_SAMPLE_URLS);

  const sampleUrls = rows.map((r) => r.finalUrl ?? r.url);

  let origin = `https://${domain}`;
  const seed = sampleUrls[0];
  if (seed) {
    try {
      origin = new URL(seed).origin;
    } catch {
      // Keep the domain-derived default.
    }
  }

  return { domain, origin, sampleUrls };
}

function emptyResult(aiUnavailableReason: string | null): OptimizationRunResult {
  return {
    generated: 0,
    bySource: { rule: 0, ai: 0 },
    unhandledIssues: 0,
    preservedReviews: 0,
    aiEnabled: aiUnavailableReason === null,
    aiUnavailableReason,
    aiPagesSkipped: 0,
    aiFailedPages: 0,
    aiError: null,
  };
}
