import { useEffect, useState } from "react";
import "./DateRangePicker.css";

export interface Range {
  start: string;
  end: string;
}

/**
 * Presets first, calendar second.
 *
 * Almost every real question is "the last N days", and making that one click
 * keeps the custom inputs out of the way for the rare case that needs them.
 * 16 months is Google's retention ceiling, so nothing longer is offered --
 * an option that always returns a truncated range is worse than no option.
 */
const PRESETS: Array<{ label: string; days: number }> = [
  { label: "7d", days: 7 },
  { label: "28d", days: 28 },
  { label: "3m", days: 90 },
  { label: "6m", days: 180 },
  { label: "16m", days: 480 },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (from: string, days: number) => iso(new Date(new Date(`${from}T00:00:00Z`).getTime() + days * 86_400_000));

export function DateRangePicker({
  value,
  latestAvailable,
  busy,
  onChange,
}: {
  value: Range;
  /** Newest day with settled data; the calendar cannot go past it. */
  latestAvailable: string;
  /**
   * Shown as a subtle loading hint -- it must NOT disable the controls.
   * A six-month range can take half a minute to pull, and disabling the
   * picker for its duration strands the user on the one range that is still
   * loading, unable to go back to data they already have.
   */
  busy: boolean;
  onChange: (next: Range) => void;
}) {
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState<Range>(value);

  // Keep the draft aligned when a preset changes the range from outside.
  useEffect(() => setDraft(value), [value]);

  function applyPreset(days: number) {
    setCustom(false);
    onChange({ start: shift(latestAvailable, -(days - 1)), end: latestAvailable });
  }

  /** Which preset, if any, the current range corresponds to. */
  function activePreset(): number | null {
    if (value.end !== latestAvailable) return null;
    const span =
      Math.round(
        (new Date(`${value.end}T00:00:00Z`).getTime() - new Date(`${value.start}T00:00:00Z`).getTime()) / 86_400_000,
      ) + 1;
    return PRESETS.find((p) => p.days === span)?.days ?? null;
  }

  const active = activePreset();

  return (
    <div className={`dr-picker${busy ? " dr-picker-busy" : ""}`}>
      <div className="dr-presets" role="group" aria-label="Date range">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            aria-pressed={!custom && active === p.days}
            className={`dr-preset${!custom && active === p.days ? " dr-preset-active" : ""}`}
            onClick={() => applyPreset(p.days)}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={custom}
          className={`dr-preset${custom ? " dr-preset-active" : ""}`}
          onClick={() => setCustom((c) => !c)}
        >
          Custom
        </button>
      </div>

      {custom && (
        <div className="dr-custom">
          <input
            type="date"
            className="dr-date"
            value={draft.start}
            max={latestAvailable}
            onChange={(e) => setDraft({ ...draft, start: e.target.value })}
          />
          <span className="dr-arrow">→</span>
          <input
            type="date"
            className="dr-date"
            value={draft.end}
            // Capped at the newest settled day: picking today returns nothing,
            // which reads as "the site got no traffic" rather than "too soon".
            max={latestAvailable}
            onChange={(e) => setDraft({ ...draft, end: e.target.value })}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!draft.start || !draft.end}
            onClick={() => onChange(draft)}
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
