// Shared inspector controls — the toggle/segmented/row primitives PROMOTED VERBATIM from SettingsPage.tsx so
// the Settings page and the #spine inspector share ONE source of truth for switch/segmented styling + a11y.
// Tokens only, no inline JS style objects. Behaviour is unchanged from the SettingsPage originals; the only
// edit is `export` on each. See SettingsPage.tsx for the original per-control design notes.

import { useId, type ReactNode } from 'react';

// A labelled integer input (padding/maxSize/maxEdge/defaultQuality). min/max/step are guidance (the config
// parse clamps on load; buildFixOptions passes the live value raw — these are power-user knobs).
export function NumberRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 font-mono text-[13px] text-ink-soft" title={hint}>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step ?? 1}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[13px] text-ink focus:border-teal"
      />
    </label>
  );
}

// ── SettingRow — the shared knob-row layout. Promotes a knob's former mouse-only title={hint} to a VISIBLE
//    hint line under the label. `labelId` lets an interactive control (Switch button / Segmented radiogroup)
//    take its accessible name from the visible label via aria-labelledby. Pure layout, no t() of its own. ──
export function SettingRow({ label, hint, labelId, control }: { label: string; hint?: string; labelId?: string; control: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <div className="min-w-0 flex-1">
        <span id={labelId} className="font-mono text-[13px] text-ink-soft">
          {label}
        </span>
        {hint ? <p className="mt-0.5 font-mono text-[12px] leading-relaxed text-ink-soft">{hint}</p> : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

// ── Switch — a native <button role="switch">. Space/Enter toggle for free; the SR announces on/off via
//    aria-checked + aria-labelledby; the KNOB POSITION encodes state (WCAG 1.4.1 — colour is never the sole
//    signal). Track: on ⇒ bg-cta, off ⇒ bg-film-mute; the puck is a fixed white bg-white; motion-reduce kills
//    both transitions. ──
export function Switch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (b: boolean) => void }) {
  const labelId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      onClick={() => onChange(!checked)}
      className="flex w-full flex-wrap items-start justify-between gap-x-3 gap-y-1 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
    >
      <span className="min-w-0 flex-1">
        <span id={labelId} className="block font-mono text-[13px] text-ink-soft">
          {label}
        </span>
        {hint ? <span className="mt-0.5 block font-mono text-[12px] leading-relaxed text-ink-soft">{hint}</span> : null}
      </span>
      <span
        aria-hidden="true"
        className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-line/60 transition-colors motion-reduce:transition-none ${
          checked ? 'bg-cta' : 'bg-film-mute'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}

// ── Segmented — a native role=radiogroup of visually-hidden radios sharing one generated name, so arrow-key
//    navigation + Space selection come for free. The active pill = peer-checked:bg-teal-text
//    peer-checked:text-panel (AA in both themes); track bg-bg; peer-focus-visible puts the ring on the VISIBLE
//    segment. Optional `disabled` mirrors a <select disabled>. ──
export function Segmented<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const labelId = useId();
  const name = useId();
  return (
    <SettingRow
      label={label}
      hint={hint}
      labelId={labelId}
      control={
        <div role="radiogroup" aria-labelledby={labelId} className={`inline-flex flex-wrap gap-0.5 rounded-lg border border-line bg-bg p-0.5 ${disabled ? 'opacity-60' : ''}`}>
          {options.map((o) => (
            <label key={o.value} className={disabled ? 'cursor-not-allowed' : 'cursor-pointer'}>
              <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={disabled} onChange={() => onChange(o.value)} className="peer sr-only" />
              <span className="block rounded-md px-2 py-0.5 font-mono text-[13px] text-ink-soft transition peer-checked:bg-teal-text peer-checked:text-panel peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-teal motion-reduce:transition-none">
                {o.label}
              </span>
            </label>
          ))}
        </div>
      }
    />
  );
}
