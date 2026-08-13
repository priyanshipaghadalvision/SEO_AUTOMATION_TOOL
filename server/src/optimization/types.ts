import type { Heading, PageImage, PageScript, StructuredDataItem } from "../db/schema.js";
import type { Risk } from "../analysis/rules.js";

export type OptimizationAction =
  | "UPDATE_TITLE"
  | "UPDATE_DESCRIPTION"
  | "ADD_CANONICAL"
  | "ADD_H1"
  | "SET_IMAGE_ALT"
  | "ADD_SCHEMA"
  | "DEFER_SCRIPTS"
  | "FIX_REDIRECT_CHAIN"
  | "ADD_ROBOTS_TXT"
  | "ADD_SITEMAP";

export type OptimizationSource = "rule" | "ai";

/**
 * A proposal before it reaches the database: everything a provider decided,
 * with none of the storage bookkeeping (ids, dedupe key, timestamps) that the
 * orchestrator adds. Keeping providers on this shape means they stay pure
 * functions of their input and can't write to the database themselves.
 */
export interface OptimizationDraft {
  /** Null for site-wide proposals. */
  pageId: string | null;
  url: string | null;
  issueType: string;
  action: OptimizationAction;
  /** Sub-element the change applies to (image src, script URL); null if page-wide. */
  target: string | null;
  oldValue: string | null;
  newValue: string;
  reason: string;
  /** 0-100. */
  confidence: number;
  risk: Risk;
  source: OptimizationSource;
  model: string | null;
}

/**
 * The page context a provider is allowed to reason over.
 *
 * Mirrors `PageFacts` in the analysis layer: a plain data shape rather than
 * the Drizzle row, so providers are unit-testable and can't reach back into
 * the database mid-generation. `contentText` is included here (it is not in
 * PageFacts) because rewriting a title or description is impossible without
 * seeing what the page is actually about.
 */
export interface OptimizationPageContext {
  id: string;
  url: string;
  finalUrl: string | null;
  redirectChain: string[] | null;
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  lang: string | null;
  headings: Heading[];
  images: PageImage[];
  structuredData: StructuredDataItem[];
  contentText: string | null;
  wordCount: number;
  scripts: PageScript[];
  blockingScriptCount: number;
}

/** One issue handed to a provider, paired with the page it was found on. */
export interface OptimizationTask {
  issueType: string;
  /** Rule-specific evidence from the issue row (counts, offending values). */
  detail: Record<string, unknown> | null;
  /** Null for site-wide issues. */
  page: OptimizationPageContext | null;
  /** Site context, always present -- providers need the domain for branding. */
  site: SiteContext;
}

export interface SiteContext {
  domain: string;
  origin: string;
  /** Canonical URLs of up to a few dozen crawled pages, for sitemap generation. */
  sampleUrls: string[];
}

/**
 * What a provider hands back.
 *
 * Failures are part of the return value rather than something logged and
 * swallowed. A run that produced no AI proposals because the account is out
 * of credit looks identical to one where the model simply had nothing to
 * suggest -- unless the reason travels back with the result, which is
 * exactly the confusion this shape exists to prevent.
 */
export interface ProviderResult {
  drafts: OptimizationDraft[];
  /** Pages that errored and produced nothing. */
  failedPages: number;
  /** First error message seen, for surfacing to the user verbatim. */
  firstError: string | null;
}

export interface OptimizationProvider {
  readonly source: OptimizationSource;
  readonly model: string | null;
  /**
   * Returns drafts for whichever tasks this provider can handle. A provider
   * that has nothing useful to say about a task must skip it rather than
   * invent a low-quality fix -- an empty result is a valid answer.
   */
  generate(tasks: OptimizationTask[]): Promise<ProviderResult>;
}
