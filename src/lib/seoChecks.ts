import type { Heading, PageImage, StructuredDataItem } from "../api/client";

export type Severity = "ok" | "warn" | "error";

export interface Observation {
  severity: Severity;
  message: string;
}

/**
 * Evaluates heading structure the way a crawler reading the document outline
 * would: exactly one H1, no skipped levels, and no empty headings.
 */
export function analyzeHeadings(headings: Heading[]): Observation[] {
  const out: Observation[] = [];
  if (headings.length === 0) return [{ severity: "error", message: "No headings found on this page." }];

  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length === 0) out.push({ severity: "error", message: "Missing H1 — every page should have exactly one." });
  else if (h1s.length > 1) out.push({ severity: "warn", message: `${h1s.length} H1 tags — expected exactly one.` });
  else out.push({ severity: "ok", message: "Exactly one H1." });

  if (headings[0].level !== 1) {
    out.push({ severity: "warn", message: `First heading is H${headings[0].level}, not H1.` });
  }

  // A jump from H2 straight to H4 breaks the document outline: assistive
  // tech and search engines both read the gap as a missing section level.
  const skips: string[] = [];
  for (let i = 1; i < headings.length; i++) {
    const prev = headings[i - 1].level;
    const curr = headings[i].level;
    if (curr > prev + 1) skips.push(`H${prev} → H${curr}`);
  }
  if (skips.length > 0) {
    out.push({
      severity: "warn",
      message: `${skips.length} skipped level${skips.length === 1 ? "" : "s"} (${skips.slice(0, 3).join(", ")}${
        skips.length > 3 ? "…" : ""
      }).`,
    });
  } else {
    out.push({ severity: "ok", message: "No skipped heading levels." });
  }

  return out;
}

export interface ImageSeoSummary {
  total: number;
  missingAlt: number;
  emptyAlt: number;
  missingDimensions: number;
  lazyLoaded: number;
  observations: Observation[];
}

export function analyzeImages(images: PageImage[]): ImageSeoSummary {
  const total = images.length;
  // alt === null means the attribute is absent (a real problem). alt === ""
  // is a deliberate signal that the image is decorative, so it's tracked
  // separately rather than counted as a fault.
  const missingAlt = images.filter((i) => i.alt === null).length;
  const emptyAlt = images.filter((i) => i.alt === "").length;
  const missingDimensions = images.filter((i) => i.width === null || i.height === null).length;
  const lazyLoaded = images.filter((i) => i.loading === "lazy").length;

  const observations: Observation[] = [];
  if (total === 0) return { total, missingAlt, emptyAlt, missingDimensions, lazyLoaded, observations };

  observations.push(
    missingAlt > 0
      ? { severity: "error", message: `${missingAlt} of ${total} images have no alt attribute.` }
      : { severity: "ok", message: "All images have an alt attribute." },
  );
  if (emptyAlt > 0) {
    observations.push({ severity: "ok", message: `${emptyAlt} marked decorative (alt="").` });
  }
  observations.push(
    missingDimensions > 0
      ? {
          severity: "warn",
          message: `${missingDimensions} missing width/height — causes layout shift (CLS).`,
        }
      : { severity: "ok", message: "All images declare width and height." },
  );
  if (lazyLoaded > 0) {
    observations.push({ severity: "ok", message: `${lazyLoaded} use loading="lazy".` });
  }

  return { total, missingAlt, emptyAlt, missingDimensions, lazyLoaded, observations };
}

export interface SchemaCheck {
  type: string;
  valid: boolean;
  issues: string[];
}

// Properties Google documents as required for its rich results. Kept small
// and explicit rather than pulling in a full schema.org validator, which
// would be far heavier than the value it adds here.
const REQUIRED_PROPERTIES: Record<string, string[]> = {
  Article: ["headline"],
  NewsArticle: ["headline"],
  BlogPosting: ["headline"],
  Product: ["name"],
  Recipe: ["name", "recipeIngredient"],
  Event: ["name", "startDate", "location"],
  FAQPage: ["mainEntity"],
  BreadcrumbList: ["itemListElement"],
  Organization: ["name"],
  LocalBusiness: ["name", "address"],
  VideoObject: ["name", "thumbnailUrl", "uploadDate"],
  JobPosting: ["title", "datePosted", "hiringOrganization"],
};

export function analyzeStructuredData(items: StructuredDataItem[]): SchemaCheck[] {
  return items.map((item) => {
    const rawType = item["@type"];
    const type = Array.isArray(rawType) ? String(rawType[0]) : typeof rawType === "string" ? rawType : "Unknown";
    const issues: string[] = [];

    if (!item["@context"]) issues.push("Missing @context (should be https://schema.org).");
    if (!rawType) issues.push("Missing @type.");

    for (const prop of REQUIRED_PROPERTIES[type] ?? []) {
      const value = item[prop];
      if (value === undefined || value === null || value === "") issues.push(`Missing required property "${prop}".`);
    }

    return { type, valid: issues.length === 0, issues };
  });
}

export interface MetaCheck {
  value: string | null;
  length: number;
  observation: Observation;
}

/** Google truncates titles past roughly 60 characters in most SERP layouts. */
export function analyzeTitle(title: string | null): MetaCheck {
  const length = title?.length ?? 0;
  if (!title) return { value: null, length: 0, observation: { severity: "error", message: "Missing title tag." } };
  if (length < 30)
    return { value: title, length, observation: { severity: "warn", message: `Short (${length} chars) — aim for 30–60.` } };
  if (length > 60)
    return {
      value: title,
      length,
      observation: { severity: "warn", message: `Long (${length} chars) — likely truncated in results.` },
    };
  return { value: title, length, observation: { severity: "ok", message: `Good length (${length} chars).` } };
}

/** Descriptions are typically truncated past ~160 characters. */
export function analyzeDescription(description: string | null): MetaCheck {
  const length = description?.length ?? 0;
  if (!description)
    return { value: null, length: 0, observation: { severity: "error", message: "Missing meta description." } };
  if (length < 70)
    return {
      value: description,
      length,
      observation: { severity: "warn", message: `Short (${length} chars) — aim for 70–160.` },
    };
  if (length > 160)
    return {
      value: description,
      length,
      observation: { severity: "warn", message: `Long (${length} chars) — likely truncated.` },
    };
  return { value: description, length, observation: { severity: "ok", message: `Good length (${length} chars).` } };
}

/** Compares the declared canonical against the page's own URL. */
export function analyzeCanonical(canonical: string | null, pageUrl: string): Observation {
  if (!canonical) return { severity: "warn", message: "No canonical tag declared." };
  const normalize = (u: string) => u.replace(/\/$/, "").toLowerCase();
  return normalize(canonical) === normalize(pageUrl)
    ? { severity: "ok", message: "Self-referencing canonical." }
    : { severity: "warn", message: "Points to a different URL — this page may be de-duplicated away." };
}
