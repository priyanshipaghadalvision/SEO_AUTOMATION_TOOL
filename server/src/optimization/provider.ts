import { ClaudeOptimizationProvider, DEFAULT_MODEL } from "./claudeProvider.js";
import { RuleOptimizationProvider } from "./ruleProvider.js";
import type { OptimizationProvider } from "./types.js";

export interface ProviderSet {
  /** Always present. Works offline, at no cost, for every mechanical fix. */
  rules: RuleOptimizationProvider;
  /** Null when no API key is configured; the run then falls back to rules alone. */
  ai: OptimizationProvider | null;
  /** Why `ai` is null, for surfacing in the API response rather than failing silently. */
  aiUnavailableReason: string | null;
}

/**
 * Decides which engines this run may use, from the environment.
 *
 * The AI provider is optional on purpose. A deployment with no key still gets
 * a working optimization feature — the rule engine covers every mechanical
 * fix — instead of an endpoint that 500s. The reason for the downgrade is
 * returned rather than logged so the UI can say plainly why the copy rewrites
 * are missing.
 */
export function resolveProviders(): ProviderSet {
  const rules = new RuleOptimizationProvider();
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  if (!apiKey) {
    return {
      rules,
      ai: null,
      aiUnavailableReason:
        "ANTHROPIC_API_KEY is not set. Add it to the root .env to enable AI-written titles, descriptions, H1s and alt text.",
    };
  }

  const effortRaw = process.env.OPTIMIZER_EFFORT?.trim();
  const effort = effortRaw === "medium" || effortRaw === "high" ? effortRaw : "low";
  const concurrency = Number(process.env.OPTIMIZER_CONCURRENCY) || undefined;

  return {
    rules,
    ai: new ClaudeOptimizationProvider({
      apiKey,
      model: process.env.OPTIMIZER_MODEL?.trim() || DEFAULT_MODEL,
      concurrency,
      effort,
    }),
    aiUnavailableReason: null,
  };
}
