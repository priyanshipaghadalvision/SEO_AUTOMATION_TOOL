/**
 * Date-range handling for Search Console queries.
 *
 * Two hard facts from Google shape everything here: data is only final after
 * about three days, and history stops at 16 months. A picker that lets
 * someone choose yesterday or two years ago produces an empty chart that
 * looks like a bug, so ranges are clamped to what can actually return data
 * and the clamp is reported rather than applied silently.
 */

/** Search Console data is not settled for ~3 days. */
export const DATA_LAG_DAYS = 3;
/** Google retains 16 months of Search Analytics history. */
export const MAX_HISTORY_DAYS = 16 * 30;

export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface ResolvedRange extends DateRange {
  /** Set when the requested range was narrowed, so the UI can say why. */
  clampedReason: string | null;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const isValid = (s: string | undefined): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parse(s).getTime());

/** The newest day that can hold settled data. */
export function latestUsableDate(): string {
  return iso(new Date(Date.now() - DATA_LAG_DAYS * 86_400_000));
}

export function defaultRange(days = 28): DateRange {
  const end = parse(latestUsableDate());
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { startDate: iso(start), endDate: iso(end) };
}

/**
 * Validates and clamps a requested range.
 *
 * Falls back to the default window rather than erroring on malformed input:
 * a date picker sending something odd should still render a chart, not a
 * 400 the user can't act on.
 */
export function resolveRange(start: string | undefined, end: string | undefined, fallbackDays = 28): ResolvedRange {
  if (!isValid(start) || !isValid(end)) {
    return { ...defaultRange(fallbackDays), clampedReason: null };
  }

  let startDate = start;
  let endDate = end;
  const notes: string[] = [];

  if (parse(startDate) > parse(endDate)) {
    [startDate, endDate] = [endDate, startDate];
    notes.push("start and end were swapped");
  }

  const latest = latestUsableDate();
  if (parse(endDate) > parse(latest)) {
    endDate = latest;
    notes.push(`Search Console data is ~${DATA_LAG_DAYS} days behind, so the end date moved to ${latest}`);
  }

  const earliest = iso(new Date(parse(latest).getTime() - MAX_HISTORY_DAYS * 86_400_000));
  if (parse(startDate) < parse(earliest)) {
    startDate = earliest;
    notes.push(`Google keeps 16 months of history, so the start date moved to ${earliest}`);
  }

  if (parse(startDate) > parse(endDate)) startDate = endDate;

  return { startDate, endDate, clampedReason: notes.length > 0 ? notes.join("; ") : null };
}

/** Inclusive day count. */
export function daysBetween(range: DateRange): number {
  return Math.round((parse(range.endDate).getTime() - parse(range.startDate).getTime()) / 86_400_000) + 1;
}
