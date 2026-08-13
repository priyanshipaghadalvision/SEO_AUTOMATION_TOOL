import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { DESC_MAX, DESC_MIN, TITLE_MAX, TITLE_MIN } from "../analysis/rules.js";
import type {
  OptimizationDraft,
  OptimizationPageContext,
  OptimizationProvider,
  OptimizationTask,
  ProviderResult,
  SiteContext,
} from "./types.js";
import { brandFromDomain } from "./text.js";

export const DEFAULT_MODEL = "claude-opus-5";

/**
 * Issue types worth spending a model call on: every one needs a judgement
 * about what the page is actually about, which is exactly what the rule
 * provider cannot do.
 *
 * Purely mechanical fixes (canonical tags, sitemap XML, defer attributes) are
 * deliberately absent — a model would produce the same string the rule
 * provider already produces for free, less reliably.
 */
export const AI_SUPPORTED_ISSUES = new Set([
  "title.missing",
  "title.too_short",
  "title.too_long",
  "title.duplicate",
  "description.missing",
  "description.too_short",
  "description.too_long",
  "description.duplicate",
  "heading.h1_missing",
  "image.alt_missing",
]);

/**
 * How many pages are in flight at once.
 *
 * One request per page rather than per issue: a page's title, description and
 * H1 have to agree with each other, and generating them together is both
 * cheaper and more coherent than three isolated calls. Four concurrent
 * requests keeps a large crawl moving without pushing the account into rate
 * limiting or making the run hostile to anything else using the same key.
 */
const DEFAULT_CONCURRENCY = 4;

/** Images sent per page. Sending fifty thumbnails is cost with no benefit. */
const MAX_IMAGES_PER_REQUEST = 12;
/** Page copy sent as context. Enough to know the topic; far short of the cap. */
const MAX_CONTENT_CHARS = 4000;

const ACTIONS = [
  "UPDATE_TITLE",
  "UPDATE_DESCRIPTION",
  "ADD_H1",
  "SET_IMAGE_ALT",
] as const;

const FixSchema = z.object({
  issueType: z.string().describe("The exact issueType string from the task list this fix answers."),
  action: z.enum(ACTIONS),
  target: z
    .string()
    .nullable()
    .describe("For SET_IMAGE_ALT, the image src exactly as given. Null for every other action."),
  newValue: z
    .string()
    .describe(
      "The replacement value only — the title text, the description text, the alt text, or the H1 text. No HTML tags, no quotes, no labels.",
    ),
  reason: z
    .string()
    .describe("One or two sentences on why this wording is better, specific to this page."),
  confidence: z
    .number()
    .describe("0-100. How confident you are this is a genuine improvement given the page content."),
});

const BatchSchema = z.object({
  fixes: z.array(FixSchema),
});

type Fix = z.infer<typeof FixSchema>;

const SYSTEM_PROMPT = `You are an SEO copy editor. You are given one web page's crawled content and a list of metadata problems found on it. Return a concrete replacement value for each problem you can genuinely improve.

Rules for the values you write:
- Titles: ${TITLE_MIN}-${TITLE_MAX} characters, lead with the page's actual subject, no clickbait, no keyword stuffing. Append " | <Brand>" only if it fits in the budget.
- Meta descriptions: ${DESC_MIN}-${DESC_MAX} characters, describe what the visitor will find, written as prose rather than a keyword list.
- H1: the page's subject in plain language, without the brand suffix a title carries.
- Image alt text: describe what the image shows, based on the page content and the filename. Under 125 characters. No "image of" or "picture of" prefixes.

Ground every value in the page content you are given. If the content does not tell you what the page is about, omit that fix rather than inventing a plausible-sounding one — an omission is a correct answer and a fabrication is not. Return only the values, with no surrounding HTML or markdown.`;

/**
 * Rewrites page copy with Claude, one request per page.
 *
 * Constructed only when a key is available (see `resolveProvider`), so nothing
 * here needs to defend against a missing credential at call time.
 */
export class ClaudeOptimizationProvider implements OptimizationProvider {
  readonly source = "ai" as const;
  readonly model: string;

  private readonly client: Anthropic;
  private readonly concurrency: number;
  private readonly effort: "low" | "medium" | "high";

  constructor(opts: { apiKey: string; model?: string; concurrency?: number; effort?: "low" | "medium" | "high" }) {
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 3 });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
    // Copy editing against supplied content is a short, scoped task, and this
    // runs once per page across a whole crawl -- low effort keeps a 200-page
    // run affordable and fast without measurably worse titles.
    this.effort = opts.effort ?? "low";
  }

  async generate(tasks: OptimizationTask[]): Promise<ProviderResult> {
    const byPage = groupByPage(tasks);
    if (byPage.length === 0) return { drafts: [], failedPages: 0, firstError: null };

    const results = await mapWithConcurrency(byPage, this.concurrency, (group) =>
      this.generateForPage(group.page, group.site, group.tasks),
    );

    const failures = results.filter((r) => r.error !== null);
    return {
      drafts: results.flatMap((r) => r.drafts),
      failedPages: failures.length,
      firstError: failures[0]?.error ?? null,
    };
  }

  private async generateForPage(
    page: OptimizationPageContext,
    site: SiteContext,
    tasks: OptimizationTask[],
  ): Promise<{ drafts: OptimizationDraft[]; error: string | null }> {
    let fixes: Fix[];
    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        output_config: {
          effort: this.effort,
          format: zodOutputFormat(BatchSchema),
        },
        messages: [{ role: "user", content: buildUserPrompt(page, site, tasks) }],
      });

      // Opus 5's safety classifiers can decline a request outright. That
      // returns HTTP 200 with an empty body, so the check has to happen
      // before the parsed output is read.
      if (response.stop_reason === "refusal") {
        const category = response.stop_details?.category ?? "unknown";
        console.warn(`[optimize] model declined page ${page.url} (${category})`);
        return { drafts: [], error: `Model declined to answer (${category}).` };
      }
      fixes = response.parsed_output?.fixes ?? [];
    } catch (err) {
      // One page failing must not sink the whole run: the orchestrator has
      // already produced rule-based proposals for most of these issues, so a
      // dropped page degrades quality rather than breaking the feature.
      //
      // The message travels back with the result rather than only reaching
      // the console -- an account with no credit fails every page, and
      // "0 AI proposals" with no stated reason is indistinguishable from
      // "the model had nothing to add".
      const message = summariseError(err);
      console.error(`[optimize] page ${page.url} failed: ${message}`);
      return { drafts: [], error: message };
    }

    const requested = new Set(tasks.map((t) => t.issueType));
    const validImageSrcs = new Set(page.images.filter((i) => i.alt === null).map((i) => i.src));
    const out: OptimizationDraft[] = [];

    for (const fix of fixes) {
      // The model is told which issues to answer; anything else it volunteers
      // has no matching issue row and would surface as an orphan proposal.
      if (!requested.has(fix.issueType)) continue;
      const value = fix.newValue.trim();
      if (!value) continue;

      let target: string | null = null;
      if (fix.action === "SET_IMAGE_ALT") {
        if (!fix.target || !validImageSrcs.has(fix.target)) continue;
        target = fix.target;
      }

      out.push({
        pageId: page.id,
        url: page.finalUrl ?? page.url,
        issueType: fix.issueType,
        action: fix.action,
        target,
        oldValue: currentValueFor(fix, page),
        newValue: renderValue(fix.action, value),
        reason: fix.reason.trim(),
        confidence: clampConfidence(fix.confidence),
        risk: RISK_BY_ACTION[fix.action],
        source: "ai",
        model: this.model,
      });
    }

    return { drafts: out, error: null };
  }
}

/**
 * Turns an SDK error into one line a user can act on.
 *
 * The SDK's own `message` embeds the whole JSON error body, which is noise in
 * a UI banner; the typed classes carry the same information in a form worth
 * reading. Billing gets called out by name because it is both the most
 * common first-run failure and the one with the least obvious fix from the
 * raw text.
 */
function summariseError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in the root .env.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Anthropic rate limit reached. Lower OPTIMIZER_CONCURRENCY or retry shortly.";
  }
  if (err instanceof Anthropic.APIError) {
    const detail = (err.error as { error?: { message?: string } } | undefined)?.error?.message;
    if (detail?.includes("credit balance")) {
      return "Anthropic account is out of credit. Add credits at console.anthropic.com under Plans & Billing.";
    }
    return detail ?? `Anthropic API error ${err.status ?? ""}`.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

const RISK_BY_ACTION: Record<(typeof ACTIONS)[number], "low" | "medium" | "high"> = {
  // Titles are the strongest on-page ranking signal, so replacing one on a
  // page that already ranks is the change most worth a human look.
  UPDATE_TITLE: "medium",
  UPDATE_DESCRIPTION: "low",
  ADD_H1: "medium",
  SET_IMAGE_ALT: "low",
};

/**
 * Wraps a bare value in the markup it belongs in.
 *
 * The model is asked for values rather than tags because a value is far
 * harder to malform, and because the surrounding markup is a fixed, known
 * shape that does not need generating.
 */
function renderValue(action: (typeof ACTIONS)[number], value: string): string {
  switch (action) {
    case "UPDATE_TITLE":
    case "UPDATE_DESCRIPTION":
      return value;
    case "ADD_H1":
      return `<h1>${value}</h1>`;
    case "SET_IMAGE_ALT":
      return `alt="${value.replace(/"/g, "&quot;")}"`;
  }
}

function currentValueFor(fix: Fix, page: OptimizationPageContext): string | null {
  switch (fix.action) {
    case "UPDATE_TITLE":
      return page.title;
    case "UPDATE_DESCRIPTION":
      return page.metaDescription;
    case "SET_IMAGE_ALT":
      return page.images.find((i) => i.src === fix.target)?.snippet ?? null;
    default:
      return null;
  }
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function buildUserPrompt(
  page: OptimizationPageContext,
  site: SiteContext,
  tasks: OptimizationTask[],
): string {
  const lines: string[] = [];

  lines.push(`# Page`);
  lines.push(`URL: ${page.finalUrl ?? page.url}`);
  lines.push(`Site: ${site.domain} (brand: ${brandFromDomain(site.domain)})`);
  if (page.lang) lines.push(`Language: ${page.lang}`);
  lines.push(`Current title: ${page.title ?? "(none)"}`);
  lines.push(`Current meta description: ${page.metaDescription ?? "(none)"}`);

  const headings = page.headings.slice(0, 25);
  if (headings.length > 0) {
    lines.push("", "## Headings");
    for (const h of headings) lines.push(`${"#".repeat(Math.min(6, h.level))} ${h.text}`);
  }

  if (page.contentText) {
    lines.push("", "## Page content", page.contentText.slice(0, MAX_CONTENT_CHARS));
  }

  const needsAlt = tasks.some((t) => t.issueType === "image.alt_missing");
  if (needsAlt) {
    const missing = page.images.filter((i) => i.alt === null).slice(0, MAX_IMAGES_PER_REQUEST);
    if (missing.length > 0) {
      lines.push("", "## Images with no alt attribute");
      lines.push("Return one SET_IMAGE_ALT fix per image, with `target` set to the src exactly as written here.");
      for (const img of missing) lines.push(`- ${img.src}`);
    }
  }

  lines.push("", "## Problems to fix");
  for (const task of tasks) {
    lines.push(`- ${task.issueType}${describeDetail(task.detail)}`);
  }

  return lines.join("\n");
}

/** Surfaces the evidence the analyser recorded, e.g. which pages share a title. */
function describeDetail(detail: Record<string, unknown> | null): string {
  if (!detail) return "";
  const bits: string[] = [];
  if (typeof detail.length === "number") bits.push(`current length ${detail.length}`);
  if (typeof detail.count === "number" && Array.isArray(detail.urls)) {
    bits.push(`shared with ${detail.count - 1} other page(s)`);
  }
  return bits.length > 0 ? ` (${bits.join(", ")})` : "";
}

function groupByPage(
  tasks: OptimizationTask[],
): Array<{ page: OptimizationPageContext; site: SiteContext; tasks: OptimizationTask[] }> {
  const groups = new Map<string, { page: OptimizationPageContext; site: SiteContext; tasks: OptimizationTask[] }>();
  for (const task of tasks) {
    if (!task.page) continue; // Site-wide issues are the rule provider's job.
    const existing = groups.get(task.page.id);
    if (existing) existing.tasks.push(task);
    else groups.set(task.page.id, { page: task.page, site: task.site, tasks: [task] });
  }
  return [...groups.values()];
}

/**
 * Runs `fn` over `items` with at most `limit` in flight.
 *
 * A pool of workers pulling from a shared cursor rather than fixed-size
 * batches: a slow page never holds back the pages behind it, which matters
 * when one request thinks for eight seconds and the next returns in one.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
