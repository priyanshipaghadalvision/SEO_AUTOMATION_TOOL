/**
 * Text shaping helpers shared by the optimization providers.
 *
 * Kept separate from the providers themselves because every one of these is a
 * pure string transform with an exact contract worth being able to reason
 * about (and test) on its own -- "never exceeds max", "never cuts mid-word".
 */

/** Separators publishers conventionally use between a page title and a brand. */
const BRAND_SEPARATORS = ["|", "–", "—", "·", "-", "»", ":"];

/**
 * Trims `value` to at most `max` characters without splitting a word.
 *
 * Falls back to a hard cut only when the first word is itself longer than the
 * limit, which is the one case where a word boundary doesn't exist.
 */
export function truncateAtWord(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;

  const cut = clean.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace <= 0) return clean.slice(0, max).trim();
  return trimDanglingWords(cut.slice(0, lastSpace));
}

/**
 * Words a sentence cannot end on. Cutting at a word boundary is not enough on
 * its own -- "Simplifying UI Testing in React: Tools and" is a valid word
 * boundary and still reads as a broken title, so the trailing connective goes
 * too. Repeats until the last word carries meaning.
 */
const DANGLING_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "how", "if", "in", "into", "is",
  "it", "its", "of", "on", "or", "our", "so", "that", "the", "their", "this", "to", "via",
  "was", "were", "what", "when", "which", "who", "why", "with", "your",
]);

function trimDanglingWords(value: string): string {
  let out = value.replace(/[\s,;:–—-]+$/, "").trim();
  for (;;) {
    const match = out.match(/\s([A-Za-z']+)$/);
    if (!match || !DANGLING_WORDS.has((match[1] ?? "").toLowerCase())) break;
    out = out.slice(0, match.index).replace(/[\s,;:–—-]+$/, "").trim();
  }
  return out;
}

/**
 * Shortens a title to `max` while keeping any trailing brand suffix intact.
 *
 * "A Very Long Descriptive Title About Things | Acme" becomes
 * "A Very Long Descriptive Title | Acme" rather than losing the brand, which
 * is what a naive truncation would do and what makes SERP listings look
 * broken. Returns null when no shortening is possible without mangling the
 * result -- the caller should then leave the title alone for a human or an
 * LLM to rewrite properly.
 */
export function shortenTitleKeepingBrand(title: string, max: number): string | null {
  const clean = title.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return null;

  const split = splitBrand(clean);
  if (split) {
    const suffix = ` ${split.separator} ${split.brand}`;
    const headBudget = max - suffix.length;
    // Only worth preserving the brand if a meaningful head still fits.
    if (headBudget >= 20) {
      const head = truncateAtWord(split.head, headBudget);
      if (head.length >= 20) return `${head}${suffix}`;
    }
  }

  const plain = truncateAtWord(clean, max);
  return plain.length >= 20 ? plain : null;
}

/** Splits "Head | Brand" on the last brand separator, if one is present. */
function splitBrand(title: string): { head: string; separator: string; brand: string } | null {
  for (const separator of BRAND_SEPARATORS) {
    const at = title.lastIndexOf(` ${separator} `);
    if (at <= 0) continue;
    const head = title.slice(0, at).trim();
    const brand = title.slice(at + separator.length + 2).trim();
    // A "brand" longer than this is almost certainly just more title text.
    if (brand.length === 0 || brand.length > 30 || head.length === 0) continue;
    return { head, separator, brand };
  }
  return null;
}

/**
 * Shortens already-written copy to `max`: whole sentences where possible,
 * falling back to a word-boundary cut when the first sentence already exceeds
 * the limit.
 *
 * Safe to use on an existing meta description, where the input is known to be
 * human-written. Do NOT use it on raw page text -- see `extractProseSummary`.
 */
export function summariseToLength(text: string, max: number, min: number): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length < min) return null;

  const sentences = takeWholeSentences(clean, max);
  if (sentences && sentences.length >= min) return sentences;

  const cut = truncateAtWord(clean, max);
  return cut.length >= min ? cut : null;
}

/**
 * Pulls a usable description out of a page's raw extracted text.
 *
 * Stricter than `summariseToLength` on purpose, and the reason is a real
 * failure this caught: on a nav-heavy page the extracted text starts
 * "Home Products Products HR Payroll Software Compensation Management..." --
 * a word-boundary cut of that is a syntactically valid, completely useless
 * description, and shipping it would be worse than proposing nothing.
 *
 * So there is no truncation fallback here, and the result must actually read
 * like prose. A page whose text is only menu labels correctly yields null.
 */
export function extractProseSummary(text: string, max: number, min: number): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length < min) return null;

  const summary = takeWholeSentences(clean, max);
  if (!summary || summary.length < min) return null;
  return looksLikeProse(summary) ? summary : null;
}

/**
 * Greedily accumulates complete sentences from the start while staying within
 * `max`.
 *
 * Scans forward from index 0 rather than collecting matches with a global
 * regex: `String.match` skips regions it can't match, so on text like
 * "Testers.AI SDK for Playwright (.NET).Playwright.Self-contained guide..."
 * -- where run-together periods have no following space -- it silently
 * returned a fragment starting mid-word. Anchoring the slice at 0 makes that
 * impossible by construction.
 *
 * A terminator only counts when followed by whitespace or end-of-string, so
 * ".NET", "v1.2" and "e.g." don't split a sentence.
 */
function takeWholeSentences(clean: string, max: number): string | null {
  const terminator = /[.!?]+(?=\s|$)/g;
  let out = "";
  let match: RegExpExecArray | null;

  while ((match = terminator.exec(clean)) !== null) {
    const candidate = clean.slice(0, match.index + match[0].length).trim();
    if (candidate.length > max) break;
    out = candidate;
  }
  return out.length > 0 ? out : null;
}

/**
 * Distinguishes sentences from a run of navigation labels.
 *
 * Menu text is overwhelmingly Title Case ("Products", "HR Payroll Software");
 * real prose is mostly lowercase because of its connecting words. Requiring
 * at least 40% all-lowercase words separates the two reliably without
 * needing to know anything about the language's vocabulary.
 */
function looksLikeProse(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length < 8) return false;
  const lower = words.filter((w) => w === w.toLowerCase()).length;
  return lower / words.length >= 0.4;
}

/**
 * Turns an image filename into candidate alt text: "hero-blue-widget@2x.jpg"
 * becomes "Hero blue widget".
 *
 * Returns null for filenames that carry no meaning -- hashes, numeric names,
 * generic slugs. Guessing "Image 4837" as alt text is worse for a screen
 * reader than the empty attribute it would replace, so this deliberately
 * declines more often than it accepts.
 */
export function altFromFilename(src: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(new URL(src, "https://x.invalid").pathname.split("/").pop() ?? "");
  } catch {
    return null;
  }

  const base = name
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[@_-]+\d+x$/i, "")
    .replace(/[-_.+]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  if (base.length < 3 || base.length > 100) return null;
  // Hashes, UUIDs, and bare numbers describe nothing.
  if (/^[0-9\s]+$/.test(base)) return null;
  if (/^[0-9a-f\s]{16,}$/i.test(base)) return null;
  const words = base.split(" ").filter((w) => /[a-z]/i.test(w));
  if (words.length === 0) return null;
  if (words.every((w) => GENERIC_IMAGE_WORDS.has(w.toLowerCase()))) return null;

  const text = words.join(" ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const GENERIC_IMAGE_WORDS = new Set([
  "favicon",
  "favicons",
  "logo",
  "logos",
  "icon",
  "icons",
  "banner",
  "bg",
  "background",
  "hero",
  "img",
  "image",
  "images",
  "photo",
  "pic",
  "picture",
  "asset",
  "assets",
  "file",
  "upload",
  "uploads",
  "untitled",
  "default",
  "placeholder",
  "thumb",
  "thumbnail",
  "screenshot",
  "download",
  "copy",
  "final",
  "new",
]);

/**
 * Reads a page title out of its URL slug, for pages that have no H1 either:
 * "/blog/how-to-pick-a-crm/" becomes "How to pick a crm".
 */
export function titleFromUrlSlug(url: string): string | null {
  let slug: string;
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    slug = segments[segments.length - 1] ?? "";
  } catch {
    return null;
  }
  const base = slug
    .replace(/\.(html?|php|aspx?)$/i, "")
    .replace(/[-_+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (base.length < 3) return null;
  const words = base.split(" ").filter((w) => /[a-z]/i.test(w));
  if (words.length === 0) return null;
  const text = words.join(" ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "shop.example.co.uk" -> "Example". Best-effort brand name for a title suffix. */
export function brandFromDomain(domain: string): string {
  const host = domain.replace(/^www\./i, "");
  const parts = host.split(".");
  // Handles both "example.com" and multi-part TLDs like "example.co.uk".
  const name = parts.length > 2 && (parts[parts.length - 2] ?? "").length <= 3
    ? parts[parts.length - 3]
    : parts[parts.length - 2] ?? parts[0];
  const clean = (name ?? host).replace(/[-_]+/g, " ").trim();
  return clean
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Minimal XML escaping for values placed into generated sitemap markup. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
