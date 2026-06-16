import type { ChangeEvent, ReactNode } from "react";

// ---- Shared class tokens -----------------------------------------------------

/** Bordered surface used for list rows / panels. Light + dark. */
export const CARD_CLASS =
  "rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900";

/** Same surface, but lifts/highlights on hover — for clickable rows. */
export const CARD_INTERACTIVE_CLASS =
  `${CARD_CLASS} transition hover:-translate-y-0.5 hover:border-accent/60 hover:shadow-md`;

/** Primary (accent) button. */
export const BTN_PRIMARY_CLASS =
  "inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-accent";

/** Destructive (red) button — same shape as primary, for stop/delete actions. */
export const BTN_DANGER_CLASS =
  "inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-red-600";

/** Neutral bordered button. */
export const BTN_GHOST_CLASS =
  "inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1 text-sm transition-colors hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent dark:border-gray-700 dark:hover:bg-gray-800 dark:disabled:hover:bg-transparent";

/** Form field (input/select). */
export const FIELD_CLASS =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 transition focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500";

// ---- Components --------------------------------------------------------------

/** Inline spinning ring — shown inside buttons while an action is in flight. */
export function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "filter…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`mb-4 ${FIELD_CLASS}`}
    />
  );
}

/**
 * Standard page header.
 *
 * Two slots for header controls — pick by content, not by preference:
 * - `actions`: buttons / links only. They sit inline beside the title (and wrap
 *   below it when the viewport is narrow). Keep this for a handful of buttons.
 * - `toolbar`: anything with a **form field** (text input, select, file picker).
 *   It always renders on its own full-width row UNDER the title. Putting a form
 *   in `actions` lets `justify-between` park the input to the right of — and
 *   visually above — the title on wide screens; `toolbar` prevents that.
 *
 * Rule of thumb: if the header controls include an `<input>`/`<select>`, use
 * `toolbar`. Otherwise `actions`.
 */
export function PageHeading({
  title,
  count,
  actions,
  toolbar,
}: {
  title: string;
  count?: number;
  actions?: ReactNode;
  toolbar?: ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="shrink-0 text-2xl font-bold tracking-tight">
          {title}
          {count !== undefined && <span className="ml-2 text-base font-normal text-gray-400">({count})</span>}
        </h2>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {toolbar && <div className="mt-3 flex flex-wrap items-center gap-2">{toolbar}</div>}
    </div>
  );
}

type BadgeTone = "neutral" | "accent" | "success" | "warn" | "error";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  accent: "bg-accent-soft text-accent",
  success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  error: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
};

// Field-help "ⓘ" affordance + hover Tooltip — the shared, Tailwind-first
// cwip/react components. Their defaults (accent icon/ring, white/gray surface,
// dark: variants) resolve against rubato's own theme tokens, so re-exporting them
// keeps every call site and its look on-brand (cwip's classes are picked up via
// the `@source` line in styles.css). `InfoHint` is the click-to-pin "ⓘ" for field
// help; `Tooltip` (use `multiline` for a real explanation) wraps a raw button to
// explain a non-obvious action on hover. `Dropdown` is the styled single-select
// (a themed popover list) — reach for it over a native `<select>` wherever the open
// list should match the app instead of the browser's default. Override per-call via
// className/classNames.
// `Alert` is the themeable inline status banner / callout (info/success/warning/
// error) — reach for it over a hand-rolled `rounded border bg-…-50 text-…` block so
// status messages stay on-brand and announce themselves to assistive tech.
export { Alert, type AlertTone, Dropdown, type DropdownOption, InfoHint, Tooltip } from "cwip/react";

// "Open in editor" affordances for any filesystem path shown in the UI
// (re-exported here so pages get them from the same module as the other shared
// UI primitives). See ./OpenPath for the implementation.
export { OpenPathButton, PathRef } from "./OpenPath";

/** A small on/off switch. Shared by Settings and the Admin page toggles. */
export function Switch({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-accent" : "bg-gray-300 dark:bg-gray-700"
      }`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}

/**
 * A simple underline tab bar. Presentational + controlled — the caller owns the
 * active key (component state, or a `?tab=` URL param for the merged pages). Shared
 * by the merged Excel/Requests/Runs pages, the Settings sections, and Admin.
 */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  className = "",
}: {
  tabs: readonly { key: T; label: ReactNode }[];
  active: T;
  onChange: (key: T) => void;
  className?: string;
}) {
  return (
    <div className={`mb-4 flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-800 ${className}`}>
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={`-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors ${
            t.key === active
              ? "border-accent font-medium text-accent"
              : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Soft, rounded pill label. */
export function Badge({
  tone = "neutral",
  className = "",
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_TONES[tone]} ${className}`}>
      {children}
    </span>
  );
}
