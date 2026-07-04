// The dedicated Settings page (settings-page design §5) — a builder-style, folder-INDEPENDENT config
// surface that edits the ONE BuildSettings object (settings-ctx). It hosts the controls that used to live
// as collapsed <details> panels inside the FixCard (SettingsPanel / PackPanel / ExtrudePanel / TierPanel /
// ExportProfilePanel) — MOVED here verbatim (same i18n keys, no re-keying) and re-dressed as OPEN cards —
// plus the knobs that were hardcoded in buildOptions before (defaults target/quality, padding, maxSize,
// maxEdge), the new resolution-agnostic knobs (spinePageFormat, pngRecompressLevel), and the save/load
// build-config controls. The backend-op TOGGLES live here (page UI); per-run CONSENT stays next to the Run
// button in the FixCard (invariant 1/2 — consent is never sticky, never on this page).
//
// STATE: everything is read from / written to the shared BuildSettings context — no local option state.
// A page edit changes the settings object identity (patchSettings spreads), which invalidates any pending
// FixCard plan even while the FixCard is hidden ("settings apply to the NEXT run"; design §3.2). The only
// local state is `cfgStatus` (the config load/parse message). HONESTY: nothing here generates or measures;
// the mipmap card is COPY + the existing extrude knob only (raster formats cannot store mip levels — the GPU
// generates them at load; the opt-in KTX2 backend op bakes real mips). No network, no asset bytes leave.

import { useId, useRef, useState, type ReactNode } from 'react';
import type { ExportFormat, ResolutionTier, Rule } from '@asset-doctor/core';
import type { PackMode, StaticGranularity } from '@asset-doctor/ingest';
import { DEFAULT_SCALE_TIERS, isSafeSuffix } from '@asset-doctor/fix';
import { useI18n } from '../lib/i18n';
import { useBuildSettings } from '../lib/settings-ctx';
import type { BuildSettings } from '../lib/build-settings';
import { GROUP_ORDER, groupState, RULES_IN_GROUP, setGroupHidden, toggleRule } from '../lib/view-prefs';
import { applyTheme, loadTheme, saveTheme, type Theme } from '../lib/theme';
import { FORMAT_KEYS, OVERRIDE_MODE_KEYS, type OverrideMode } from '../lib/profile-ui-types';
import { BUILD_CONFIG_VERSION, parseBuildConfig, serializeBuildConfig } from '../lib/build-config';
import { PROFILE_PANEL_ANCHOR } from '../lib/optimize-entry';
import { API_BASE, loadStoredEntitlement } from '../lib/license';

// Browser-only text download (the build-config JSON) — Blob → object-URL → <a download> → click → revoke.
// Local mirror of App's downloadZip; no network, zero asset bytes (invariant 1).
function downloadText(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type Patch = (p: Partial<BuildSettings>) => void;
interface Sect {
  s: BuildSettings;
  patch: Patch;
}

// ── Shared card chrome — the "open card" replacement for the old <details>. Tokens only: rounded-2xl border
//    border-line bg-panel p-6 + the ad-label text-teal-text eyebrow (app-screen re-skin §3, mockup chrome). ──
function Card({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="rounded-2xl border border-line bg-panel p-6 text-left">
      <h2 className="ad-label text-teal-text">{title}</h2>
      <div className="mt-3 space-y-2">{children}</div>
    </section>
  );
}

// A labelled integer input (padding/maxSize/maxEdge/defaultQuality). min/max/step are guidance (the config
// parse clamps on load; buildFixOptions passes the live value raw — these are power-user knobs).
function NumberRow({
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

// ── SettingRow — the shared knob-row layout (app-screen re-skin §1). Promotes each knob's former mouse-only
//    title={hint} to a VISIBLE hint line under the label (an a11y win — no new copy, reuses the existing hint
//    keys). `labelId` lets an interactive control (Switch button / Segmented radiogroup) take its accessible
//    name from the visible label via aria-labelledby. Pure layout, no t() of its own. ──
function SettingRow({ label, hint, labelId, control }: { label: string; hint?: string; labelId?: string; control: ReactNode }) {
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

// ── Switch — a native <button role="switch"> DROP-IN for the old CheckRow (identical props
//    label/hint/checked/onChange), so migrating a boolean knob is a mechanical tag swap. Space/Enter toggle
//    for free (native button); the SR announces on/off via aria-checked + aria-labelledby; the KNOB POSITION
//    encodes state (WCAG 1.4.1 — colour is never the sole signal). Track: on ⇒ bg-cta, off ⇒ bg-film-mute
//    (both theme-INDEPENDENT — proven by contrast.ts switchKnobPasses); the puck is a fixed white bg-white;
//    motion-reduce kills both transitions. ──
function Switch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (b: boolean) => void }) {
  const labelId = useId();
  return (
    // The WHOLE row is the role=switch button ⇒ a full-row click target (parity with the old CheckRow <label>
    // and the mockup's full-row toggles). Accessible name = the label span only (aria-labelledby, so the hint
    // is NOT folded into the name); the puck is decorative (aria-hidden) — aria-checked conveys state and the
    // KNOB POSITION encodes it visually (WCAG 1.4.1). Space/Enter toggle for free (native button).
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
//    navigation + Space selection come for free (WCAG keyboard). The active pill = peer-checked:bg-teal-text
//    peer-checked:text-panel (AA-proven in BOTH themes — chipLabelPassesAABothThemes; deliberately NOT the
//    mockup raw teal+white, which fails AA); track bg-bg; peer-focus-visible puts the ring on the VISIBLE
//    segment. Replaces the small enum <select>s with the SAME option values + the SAME onChange. Optional
//    `disabled` mirrors a <select disabled> (dependent knob) — the radios go native-disabled + the group dims. ──
function Segmented<T extends string>({
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

// ── Card: Appearance — the durable DISPLAY-theme preference (auto/light/dark). A sibling of the diagnosis
//    view-filter: a localStorage-durable UI pref applied IMMEDIATELY (precedent: the locale switch), NOT part
//    of BuildSettings/build-config — absent from the export, never invalidates a pending fix. Self-contained:
//    the theme lives on <html data-theme> (outside React), so this owns local state seeded from loadTheme().
//    a11y: a native radiogroup (<fieldset>/<legend> + radios), fully keyboard-navigable; option labels are
//    static t() literals so the i18n-app-keys scanner covers them. 'auto' removes the attribute (the CSS
//    @media(prefers-color-scheme) then drives, reacting live to the OS with zero JS). ──
function ThemeCard() {
  const { t } = useI18n();
  const [theme, setThemeState] = useState<Theme>(() => loadTheme());
  const choose = (next: Theme): void => {
    applyTheme(next, document.documentElement);
    saveTheme(next);
    setThemeState(next);
  };
  const options: { v: Theme; label: string }[] = [
    { v: 'auto', label: t('settings.theme.auto') },
    { v: 'light', label: t('settings.theme.light') },
    { v: 'dark', label: t('settings.theme.dark') },
  ];
  return (
    <Card title={t('settings.section.appearance')}>
      <p className="font-mono text-[13px] leading-relaxed text-ink-soft">{t('settings.theme.intro')}</p>
      <fieldset className="rounded border border-line/70 p-2">
        <legend className="px-1 ad-label text-ink-soft">{t('settings.theme.legend')}</legend>
        <div className="mt-1 space-y-1">
          {options.map(({ v, label }) => (
            <label key={v} className="flex items-center gap-1.5 font-mono text-[13px] text-ink-soft">
              <input
                type="radio"
                name="ad-theme"
                value={v}
                checked={theme === v}
                onChange={() => choose(v)}
                className="accent-teal"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
    </Card>
  );
}

// ── Card: Что показывать в диагнозе (Diagnosis view filter) — the honest per-rule finding-type visibility
//    control (invariant 3). It edits the SEPARATE hiddenRules view-preference slice (view-prefs.ts / App
//    state, localStorage-durable), NOT BuildSettings — so it is absent from the build-config export, never
//    invalidates a pending fix plan, and is untouched by config load/save. It NEVER suppresses anything: the
//    analysis still MEASURES every type and the VerdictBar tally stays full; the user only chooses what to
//    SEE. Checkbox semantics are "checked = shown" (default all checked ⇒ empty hidden set ⇒ byte-identical
//    to today). Its own "applies immediately" intro distinguishes it from the page-level "applies to the NEXT
//    run" note (which governs the build cards below). a11y: each group is a <fieldset>/<legend> (WCAG 1.3.1);
//    the group toggle is a native tri-state checkbox (indeterminate on a partial group) with its own
//    aria-label; the live summary is a role=status region. ──
function DiagnosisCard({ hidden, onChange }: { hidden: ReadonlySet<Rule>; onChange: (next: Set<Rule>) => void }) {
  const { t } = useI18n();
  const hiddenCount = hidden.size;
  return (
    <Card title={t('settings.section.diagnosis')}>
      <p className="font-mono text-[13px] leading-relaxed text-ink-soft">{t('settings.diagnosis.intro')}</p>
      <div className="flex items-center justify-between gap-2">
        {/* Live hidden-count — role=status so a screen reader hears it change as boxes toggle (design §9). */}
        <p role="status" aria-live="polite" className="font-mono text-[13px] text-ink-soft">
          {t('settings.diagnosis.hiddenSummary', { n: hiddenCount })}
        </p>
        {/* One-click "show all types" reset — the card-level escape (mirrors the ledger H-line's clear).
            Disabled (not removed) when nothing is hidden ⇒ a stable, discoverable control. */}
        <button
          type="button"
          disabled={hiddenCount === 0}
          onClick={() => onChange(new Set())}
          className="shrink-0 rounded border border-line px-2 py-0.5 font-mono text-[13px] text-teal-text transition hover:border-teal disabled:opacity-60 disabled:hover:border-line"
        >
          {t('settings.diagnosis.showAll')}
        </button>
      </div>
      <div className="space-y-3">
        {GROUP_ORDER.map((g) => {
          const state = groupState(hidden, g); // 'all' | 'none' | 'some' — checked = shown
          const groupName = t(`settings.diagnosis.group.${g}`);
          return (
            <fieldset key={g} className="rounded border border-line/70 p-2">
              <legend className="flex items-center gap-1.5 px-1 ad-label text-ink-soft">
                {/* Group show-all / hide-all: a tri-state checkbox. checked ⇔ the whole group is shown;
                    indeterminate ⇔ mixed. Clicking a fully-shown group hides it; clicking a partial/hidden
                    group shows it (setGroupHidden hides iff state was 'all'). Its own aria-label keeps it
                    distinct from the per-rule boxes. */}
                <input
                  type="checkbox"
                  checked={state === 'all'}
                  ref={(el) => {
                    if (el) el.indeterminate = state === 'some';
                  }}
                  aria-label={t('settings.diagnosis.groupToggle', { group: groupName })}
                  onChange={() => onChange(setGroupHidden(hidden, g, state === 'all'))}
                  className="accent-teal"
                />
                {groupName}
              </legend>
              <div className="mt-1 space-y-1">
                {RULES_IN_GROUP[g].map((r) => (
                  <label key={r} className="flex items-center gap-1.5 font-mono text-[13px] text-ink-soft">
                    <input type="checkbox" checked={!hidden.has(r)} onChange={() => onChange(toggleRule(hidden, r))} className="accent-teal" />
                    {t(`rule.${r}`)}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
    </Card>
  );
}

// ── Card: Форматы вывода (Formats) — the moved ExportProfilePanel content (minus save/load, minus the
//    <details> wrapper) + the profile-OFF defaults row. id=PROFILE_PANEL_ANCHOR (the optimize deep-link
//    target). ──
function FormatsCard({ s, patch }: Sect) {
  const { t } = useI18n();
  const formats = s.profileFormats;
  const patchFormat = (mime: ExportFormat, p: Partial<(typeof formats)[ExportFormat]>): void =>
    patch({ profileFormats: { ...formats, [mime]: { ...formats[mime], ...p } } });
  const addTier = (): void => patch({ customTiers: [...s.customTiers, { label: '0.5×', scale: 0.5, suffix: '_540p' }] });
  const patchTier = (i: number, p: Partial<ResolutionTier>): void =>
    patch({ customTiers: s.customTiers.map((tt, j) => (j === i ? { ...tt, ...p } : tt)) });
  const removeTier = (i: number): void => patch({ customTiers: s.customTiers.filter((_, j) => j !== i) });
  const addFonts444 = (): void => patch({ profileOverrides: [...s.profileOverrides, { match: 'fonts', mode: 'fonts444', quality: 85 }] });
  const addOverride = (): void => patch({ profileOverrides: [...s.profileOverrides, { match: '', mode: 'quality', quality: 85 }] });
  const patchOverride = (i: number, p: Partial<(typeof s.profileOverrides)[number]>): void =>
    patch({ profileOverrides: s.profileOverrides.map((o, j) => (j === i ? { ...o, ...p } : o)) });
  const removeOverride = (i: number): void => patch({ profileOverrides: s.profileOverrides.filter((_, j) => j !== i) });

  return (
    <Card id={PROFILE_PANEL_ANCHOR} title={t('settings.section.formats')}>
      <p className="font-mono text-[13px] leading-relaxed text-ink-soft">{t('fix.profile.hint')}</p>

      {/* Defaults (profile OFF path) — replaces the two old buildOptions hardcodes. */}
      <div className="rounded border border-line/70 p-1.5">
        <Segmented
          label={t('settings.defaultTarget')}
          hint={t('settings.defaultTarget.hint')}
          value={s.defaultTarget}
          options={FORMAT_KEYS.map(({ mime, key }) => ({ value: mime, label: t(key) }))}
          onChange={(v) => patch({ defaultTarget: v })}
        />
        <div className="mt-1.5">
          <NumberRow label={t('settings.defaultQuality')} value={s.defaultQuality} min={0} max={100} onChange={(n) => patch({ defaultQuality: n })} />
        </div>
        {/* Under an active profile these still govern PREBUILT-ATLAS-PAGE transcodes (the profile governs loose
            images + composed sheets), so they are NOT a dead duplicate of the per-format list below — say so. */}
        {s.profileEnable ? (
          <p className="mt-1.5 font-mono text-[12px] leading-relaxed text-ink-soft">{t('settings.defaults.atlasScopeNote')}</p>
        ) : null}
      </div>

      <Switch label={t('fix.profile.enable')} checked={s.profileEnable} onChange={(b) => patch({ profileEnable: b })} />

      {s.profileEnable ? (
        <div className="mt-1 space-y-3">
          {/* ── Formats ── */}
          <div>
            <p className="ad-label text-ink-soft">{t('fix.profile.formats')}</p>
            <div className="mt-1 space-y-2">
              {FORMAT_KEYS.map(({ mime, key }) => {
                const f = formats[mime];
                const isAvif = mime === 'image/avif';
                const isPng = mime === 'image/png';
                return (
                  <div key={mime} className="rounded border border-line/70 p-1.5">
                    <label className="flex items-center gap-1.5 font-mono text-[13px] text-ink-soft">
                      <input type="checkbox" checked={f.enabled} onChange={(e) => patchFormat(mime, { enabled: e.target.checked })} className="accent-teal" />
                      {t(key)}
                    </label>
                    {f.enabled ? (
                      <div className="mt-1.5 space-y-1 pl-4">
                        {!isPng && !f.lossless ? (
                          <label className="flex items-center justify-between font-mono text-[13px] text-ink-soft">
                            <span>
                              {t('fix.profile.quality')} <span className="text-ink">{f.quality}</span>
                            </span>
                            <input type="range" min={0} max={100} step={1} value={f.quality} onChange={(e) => patchFormat(mime, { quality: Number(e.target.value) })} className="ml-2 w-1/2 accent-teal" />
                          </label>
                        ) : null}
                        <label className="flex items-center gap-1.5 font-mono text-[13px] text-ink-soft" title={isAvif ? t('fix.profile.avifNoLossless') : undefined}>
                          <input type="checkbox" checked={!isAvif && f.lossless} disabled={isAvif} onChange={(e) => patchFormat(mime, { lossless: e.target.checked })} className="accent-teal disabled:opacity-60" />
                          {t('fix.profile.lossless')}
                        </label>
                        {isPng ? (
                          <label className="flex items-center gap-1.5 font-mono text-[13px] text-ink-soft" title={t('fix.profile.pngLossyHint')}>
                            <input type="checkbox" checked={!!f.pngLossy} onChange={(e) => patchFormat(mime, { pngLossy: e.target.checked })} className="accent-teal" />
                            {t('fix.profile.pngLossy')}
                          </label>
                        ) : null}
                        {mime === 'image/webp' && !f.lossless ? (
                          <label className="flex items-center gap-1.5 font-mono text-[13px] text-ink-soft">
                            <input type="checkbox" checked={f.near} onChange={(e) => patchFormat(mime, { near: e.target.checked })} className="accent-teal" />
                            {t('fix.profile.nearLossless')}
                          </label>
                        ) : null}
                        {isAvif ? <p className="font-mono text-[12px] leading-relaxed text-ink-soft">{t('fix.profile.avifNoLossless')}</p> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {formats['image/avif'].enabled ? (
            <div>
              <p className="ad-label text-ink-soft">{t('fix.profile.avifSubsample')}</p>
              <select
                aria-label={t('fix.profile.avifSubsample')}
                value={s.profileAvifSubsample === undefined ? 'default' : String(s.profileAvifSubsample)}
                onChange={(e) => patch({ profileAvifSubsample: e.target.value === 'default' ? undefined : Number(e.target.value) })}
                className="mt-1 rounded border border-line bg-panel px-1 py-0.5 font-mono text-[13px] text-ink"
              >
                <option value="default">{t('fix.profile.avifSubsample.default')}</option>
                <option value="3">{t('fix.profile.avifSubsample.444')}</option>
                <option value="1">{t('fix.profile.avifSubsample.422')}</option>
                <option value="0">{t('fix.profile.avifSubsample.420')}</option>
              </select>
            </div>
          ) : null}

          {/* ── Resolutions ── */}
          <div>
            <p className="ad-label text-ink-soft">{t('fix.profile.resolutions')}</p>
            <p className="mt-1 font-mono text-[13px] leading-relaxed text-ink-soft">{DEFAULT_SCALE_TIERS.map((tt) => tt.suffix).join('  ')}</p>
            {s.customTiers.map((tt, i) => {
              const validSuffix = isSafeSuffix(tt.suffix);
              return (
                <div key={i} className="mt-1 flex items-center gap-1.5">
                  <span className="font-mono text-[13px] text-ink-soft">{t('fix.profile.tierScale')}</span>
                  <input type="number" min={0.05} max={1} step={0.05} value={tt.scale} aria-label={t('fix.profile.tierScale')} onChange={(e) => patchTier(i, { scale: Number(e.target.value) })} className="w-16 rounded border border-line bg-panel px-1 font-mono text-[13px] text-ink" />
                  <input type="text" value={tt.suffix} aria-label={t('fix.profile.tierSuffix')} onChange={(e) => patchTier(i, { suffix: e.target.value })} placeholder="_540p" className={`w-20 rounded border bg-panel px-1 font-mono text-[13px] text-ink ${validSuffix ? 'border-line' : 'border-crit'}`} />
                  <button type="button" onClick={() => removeTier(i)} className="font-mono text-[13px] text-crit-text hover:underline" aria-label="remove">
                    ✕
                  </button>
                  {!validSuffix ? <span className="font-mono text-[12px] text-crit-text">{t('fix.profile.tierBadSuffix', { suffix: tt.suffix })}</span> : null}
                </div>
              );
            })}
            <button type="button" onClick={addTier} className="mt-1 font-mono text-[13px] text-teal-text hover:underline">
              + {t('fix.profile.addTier')}
            </button>
          </div>

          {/* ── Per-folder overrides ── */}
          <div>
            <p className="ad-label text-ink-soft">{t('fix.profile.overrides')}</p>
            <p className="mt-1 font-mono text-[13px] leading-relaxed text-ink-soft">{t('fix.profile.overridesHint')}</p>
            {s.profileOverrides.map((o, i) => (
              <div key={i} className="mt-1 flex flex-wrap items-center gap-1.5">
                <input type="text" value={o.match} onChange={(e) => patchOverride(i, { match: e.target.value })} placeholder={t('fix.profile.overrideMatchPlaceholder')} aria-label={t('fix.profile.overrides')} className="w-28 rounded border border-line bg-panel px-1 font-mono text-[13px] text-ink" />
                <select value={o.mode} aria-label={t('fix.profile.overrides')} onChange={(e) => patchOverride(i, { mode: e.target.value as OverrideMode })} className="rounded border border-line bg-panel px-1 font-mono text-[13px] text-ink">
                  {OVERRIDE_MODE_KEYS.map(({ mode, key }) => (
                    <option key={mode} value={mode}>
                      {t(key)}
                    </option>
                  ))}
                </select>
                {o.mode !== 'lossless' ? (
                  <input type="number" min={0} max={100} step={1} value={o.quality ?? 85} aria-label={t('fix.profile.quality')} onChange={(e) => patchOverride(i, { quality: Number(e.target.value) })} className="w-14 rounded border border-line bg-panel px-1 font-mono text-[13px] text-ink" />
                ) : null}
                <button type="button" onClick={() => removeOverride(i)} className="font-mono text-[13px] text-crit-text hover:underline" aria-label="remove">
                  ✕
                </button>
              </div>
            ))}
            <div className="mt-1 flex flex-wrap gap-3">
              <button type="button" onClick={addFonts444} className="font-mono text-[13px] text-teal-text hover:underline">
                + {t('fix.profile.overrideFonts444')}
              </button>
              <button type="button" onClick={addOverride} className="font-mono text-[13px] text-teal-text hover:underline">
                + {t('fix.profile.addOverride')}
              </button>
            </div>
          </div>

          <ul className="space-y-1 border-t border-line pt-2 font-mono text-[13px] leading-relaxed text-ink-soft">
            <li>{t('fix.profile.noBundleNote')}</li>
            <li>{t('fix.profile.diskNote')}</li>
            <li>{t('fix.skipped.whyNoKernel')}</li>
            <li>{t('fix.skipped.whyNoPreBlur')}</li>
            <li>{t('fix.skipped.whyNoPngquant')}</li>
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

// ── Card: Разрешения и масштабы (Resolutions) — the moved TierPanel content (Set→array adapter) + maxEdge. ──
function ResolutionsCard({ s, patch }: Sect) {
  const { t } = useI18n();
  const labelKey = (suffix: string): string => `fix.tier.label.${suffix.replace(/^[_-]/, '')}`;
  const toggle = (suffix: string, on: boolean): void => {
    const cur = s.tierSuffixes;
    patch({ tierSuffixes: on ? (cur.includes(suffix) ? cur : [...cur, suffix]) : cur.filter((x) => x !== suffix) });
  };
  return (
    <Card title={t('settings.section.resolutions')}>
      <p className="font-mono text-[13px] leading-relaxed text-ink-soft">{t('fix.tier.hint')}</p>
      <NumberRow label={t('settings.maxEdge')} value={s.maxEdge} min={128} max={16384} step={128} onChange={(n) => patch({ maxEdge: n })} />

      {/* The legacy scale-tier ladder is wire-omitted whenever an export profile is sent (buildFixOptions; the
          worker prefers the profile tiers), so it does NOTHING under a profile — the profile's own customTiers
          editor (Formats card) is then the resolution source. Hidden when a profile is active; maxEdge above
          stays visible (it is additive on both paths). State persists + reappears when the profile is off. */}
      {!s.profileEnable ? (
        <>
          <Switch label={t('fix.tier.enable')} checked={s.tierEnable} onChange={(b) => patch({ tierEnable: b })} />
          <p className="font-mono text-[13px] leading-relaxed text-ink">⚠ {t('fix.tier.inlineWarn')}</p>

          {s.tierEnable ? (
        <div className="space-y-2">
          <div className="space-y-1">
            {DEFAULT_SCALE_TIERS.map((tier) => {
              const top = tier.scale >= 1;
              return (
                <label key={tier.suffix} title={top ? t('fix.tier.inlineWarn') : undefined} className="flex items-center gap-1.5 font-mono text-[13px] text-ink-soft">
                  <input type="checkbox" checked={top || s.tierSuffixes.includes(tier.suffix)} disabled={top} onChange={(e) => toggle(tier.suffix, e.target.checked)} className="accent-teal disabled:opacity-60" />
                  {t(labelKey(tier.suffix))}
                </label>
              );
            })}
          </div>
          <p className="font-mono text-[13px] leading-relaxed text-ink-soft">{t('fix.tier.diskNote')}</p>
          <p className="font-mono text-[13px] leading-relaxed text-ink-soft">{t('fix.tier.repackNote')}</p>
          <ul className="space-y-1 border-t border-line pt-2 font-mono text-[13px] leading-relaxed text-ink-soft">
            <li>{t('fix.skipped.whyNoKernel')}</li>
            <li>{t('fix.skipped.whyNoPreBlur')}</li>
            {/* Softened, consent-agnostic tier hint (the per-run consent lives in the FixCard). */}
            {s.resampleEnable ? <li className="text-teal-text">{t('settings.resampleTierHint')}</li> : null}
          </ul>
        </div>
          ) : null}
        </>
      ) : (
        <p className="font-mono text-[13px] leading-relaxed text-ink-soft">{t('fix.tier.profileNote')}</p>
      )}
    </Card>
  );
}

// ── Card: Упаковка атласов (Packing) — the moved PackPanel content + padding/maxSize + polygon +
//    spinePageFormat. ──
function PackingCard({ s, patch }: Sect) {
  const { t } = useI18n();
  const modes: PackMode[] = ['auto', 'force-static', 'force-spine'];
  const grans: StaticGranularity[] = ['per-leaf-folder', 'one-sheet-for-all', 'per-top-level-bundle'];
  const modeKey: Record<PackMode, string> = { auto: 'auto', 'force-static': 'static', 'force-spine': 'spine' };
  const granKey: Record<StaticGranularity, string> = { 'per-leaf-folder': 'folder', 'one-sheet-for-all': 'one', 'per-top-level-bundle': 'bundle' };
  return (
    <Card title={t('settings.section.packing')}>
      <NumberRow label={t('settings.padding')} value={s.padding} min={0} max={32} onChange={(n) => patch({ padding: n })} />
      <NumberRow label={t('settings.maxSize')} value={s.maxSize} min={128} max={8192} step={128} onChange={(n) => patch({ maxSize: n })} />

      <Switch label={t('fix.polygon')} hint={t('fix.polygonHint')} checked={s.polygon} onChange={(b) => patch({ polygon: b })} />

      {/* Spine sheet-page format (design §0.1). Default 'png' ⇒ runtime-safe today; 'profile' ⇒ Spine
          repack/pack pages follow the profile/legacy target (tier-loop Spine pages stay PNG in v1). */}
      <Segmented
        label={t('settings.spineFormat')}
        value={s.spinePageFormat}
        options={[
          { value: 'png', label: t('settings.spineFormat.png') },
          { value: 'profile', label: t('settings.spineFormat.profile') },
        ]}
        onChange={(v) => patch({ spinePageFormat: v })}
      />
      <p className="font-mono text-[13px] leading-relaxed text-ink-soft">{t('settings.spineFormat.hint')}</p>

      <div className="border-t border-line pt-2">
        <Switch label={t('fix.pack.enable')} checked={s.packLoose} onChange={(b) => patch({ packLoose: b })} />
        <p className="mt-1 font-mono text-[13px] leading-relaxed text-ink">⚠ {t('fix.pack.inlineWarn')}</p>

        {s.packLoose ? (
          <div className="mt-2 space-y-2">
            <Segmented
              label={t('fix.pack.mode.label')}
              value={s.packMode}
              options={modes.map((m) => ({ value: m, label: t(`fix.pack.mode.${modeKey[m]}`) }))}
              onChange={(v) => patch({ packMode: v })}
            />
            <label className="flex items-center justify-between gap-2 font-mono text-[13px] text-ink-soft">
              {t('fix.pack.grouping.label')}
              <select aria-label={t('fix.pack.grouping.label')} value={s.packGranularity} onChange={(e) => patch({ packGranularity: e.target.value as StaticGranularity })} className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[13px] text-ink-soft transition hover:border-teal focus:border-teal">
                {grans.map((g) => (
                  <option key={g} value={g}>
                    {t(`fix.pack.grouping.${granKey[g]}`)}
                  </option>
                ))}
              </select>
            </label>
            <Switch label={t('fix.pack.trim')} checked={s.packTrim} onChange={(b) => patch({ packTrim: b })} />
            <p className="font-mono text-[13px] leading-relaxed text-ink-soft">{t('fix.pack.spinePng')}</p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ── Card: Мипмапы и швы (Mipmaps & seams) — the moved ExtrudePanel knob + HONEST copy. NO fake baking:
//    raster formats store no mip levels (the GPU generates them at load; the mipmap-cost finding measures the
//    ×4/3 ceiling); the opt-in KTX2 backend op (Backend card) bakes real mips; extrude prevents seam bleed. ──
function MipmapsCard({ s, patch }: Sect) {
  const { t } = useI18n();
  const opts = [0, 1, 2];
  return (
    <Card title={t('settings.section.mip')}>
      <Segmented
        label={t('fix.extrude')}
        value={String(s.extrude)}
        options={opts.map((n) => ({ value: String(n), label: n === 0 ? t('fix.extrude.off') : t('fix.extrude.px', { n }) }))}
        onChange={(v) => patch({ extrude: Number(v) })}
      />
      <p className="font-mono text-[13px] leading-relaxed text-ink-soft">{t('fix.extrudeHint', { px: s.extrude || 1 })}</p>
      <p className="border-t border-line pt-2 font-mono text-[13px] leading-relaxed text-ink-soft">{t('settings.mip.copy')}</p>
    </Card>
  );
}

// ── Card: Правила оптимизации (Rules) — the moved SettingsPanel content (minus the pngRecompress checkbox)
//    + the pngRecompressLevel select (0..6) + the aggressive/merge toggle. ──
function RulesCard({ s, patch }: Sect) {
  const { t } = useI18n();
  const setOverrides = (o: { match: string; quality: number }[]): void => patch({ overrides: o });
  return (
    <Card title={t('settings.section.rules')}>
      <Switch label={t('fix.merge')} checked={s.aggressive} onChange={(b) => patch({ aggressive: b })} />

      <label className="block font-mono text-[13px] text-ink-soft">
        <span className="flex items-center justify-between" title={t('fix.settings.effortHint')}>
          {t('fix.settings.effort')} <span className="text-ink">{s.effort}</span>
        </span>
        <input type="range" min={0} max={6} step={1} value={s.effort} aria-label={t('fix.settings.effort')} onChange={(e) => patch({ effort: Number(e.target.value) })} className="mt-1 w-full accent-teal" />
      </label>

      <Switch label={t('fix.settings.scaleAware')} hint={t('fix.settings.scaleAwareHint')} checked={s.scaleAwareQ} onChange={(b) => patch({ scaleAwareQ: b })} />
      {/* Legacy global WebP near-lossless is HARD-dead under an export profile (buildFixOptions omits it; the
          profile's own per-format near checkbox is then the sole source). Hidden when a profile is active so it
          is not a dead duplicate. Default profileEnable:false ⇒ still rendered ⇒ the default run is unchanged. */}
      {!s.profileEnable ? (
        <Switch label={t('fix.settings.nearLossless')} hint={t('fix.settings.nearLosslessHint')} checked={s.webpNearLossless} onChange={(b) => patch({ webpNearLossless: b })} />
      ) : null}

      {/* PNG lossless-recompress LEVEL (replaces the old boolean; 0 = off, 1..6 oxipng effort). */}
      <label className="flex items-center justify-between gap-2 font-mono text-[13px] text-ink-soft" title={t('settings.pngLevel.hint')}>
        {t('settings.pngLevel')}
        <select aria-label={t('settings.pngLevel')} value={s.pngRecompressLevel} onChange={(e) => patch({ pngRecompressLevel: Number(e.target.value) })} className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[13px] text-ink-soft transition hover:border-teal focus:border-teal">
          {[0, 1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? t('fix.extrude.off') : String(n)}
            </option>
          ))}
        </select>
      </label>

      <Switch label={t('fix.settings.opaqueAlpha')} hint={t('fix.settings.opaqueAlphaHint')} checked={s.opaqueAlpha} onChange={(b) => patch({ opaqueAlpha: b })} />
      <Switch label={t('fix.settings.bestFormat')} hint={t('fix.settings.bestFormatHint')} checked={s.bestFormatPerImage} onChange={(b) => patch({ bestFormatPerImage: b })} />
      <Switch label={t('fix.settings.frameRedundancy')} hint={t('fix.settings.frameRedundancyHint')} checked={s.frameRedundancy} onChange={(b) => patch({ frameRedundancy: b })} />
      <Switch label={t('fix.settings.trimMargin')} hint={t('fix.settings.trimMarginHint')} checked={s.trimMargin} onChange={(b) => patch({ trimMargin: b })} />

      <div className="border-t border-line pt-2">
        <p className="ad-label text-ink-soft" title={t('fix.settings.overridesHint')}>
          {t('fix.settings.overrides')}
        </p>
        {s.overrides.map((o, i) => (
          <div key={i} className="mt-1.5 flex items-center gap-1.5">
            <input
              value={o.match}
              placeholder="folder/ · type:spine"
              aria-label={t('fix.settings.overrides')}
              onChange={(e) => {
                const next = s.overrides.slice();
                next[i] = { ...o, match: e.target.value };
                setOverrides(next);
              }}
              className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[13px] text-ink focus:border-teal"
            />
            <input
              type="number"
              min={0}
              max={100}
              value={Math.round(o.quality * 100)}
              aria-label="quality"
              title="quality 0–100"
              onChange={(e) => {
                const next = s.overrides.slice();
                next[i] = { ...o, quality: Math.max(0, Math.min(100, Number(e.target.value))) / 100 };
                setOverrides(next);
              }}
              className="w-14 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[13px] text-ink focus:border-teal"
            />
            <button type="button" onClick={() => setOverrides(s.overrides.filter((_, j) => j !== i))} className="font-mono text-[13px] text-ink-soft hover:text-crit-text" aria-label="remove">
              ✕
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setOverrides([...s.overrides, { match: '', quality: 0.85 }])} className="mt-1.5 font-mono text-[13px] text-teal-text underline-offset-2 hover:underline">
          + {t('fix.settings.overrides')}
        </button>
      </div>

      <ul className="space-y-1 border-t border-line pt-2 font-mono text-[13px] leading-relaxed text-ink-soft">
        <li>{t('fix.skipped.whyNoKernel')}</li>
        <li>{t('fix.skipped.whyNoPreBlur')}</li>
        <li>{t('fix.skipped.whyNoPngquant')}</li>
        <li>{t('fix.skipped.whyNoChroma')}</li>
      </ul>
    </Card>
  );
}

// ── Card: Вывод и имена файлов (Output) — the moved manifest/includeFileSizes/hashFilenames rows. The
//    backend auto-pair (forcing the manifest ON) stays in the FixCard, where the per-run consent is known;
//    here every control is a plain checkbox/select over the live setting. ──
function OutputCard({ s, patch }: Sect) {
  const { t } = useI18n();
  return (
    <Card title={t('settings.section.output')}>
      <Switch label={t('fix.pixiManifest')} hint={t('fix.pixiManifestHint')} checked={s.emitPixiManifest} onChange={(b) => patch({ emitPixiManifest: b })} />
      <div className="ml-5">
        <Segmented
          label={t('fix.includeFileSizes')}
          hint={t('fix.includeFileSizesHint')}
          value={s.includeFileSizes}
          disabled={!s.emitPixiManifest}
          options={[
            { value: 'off', label: t('fix.includeFileSizes.off') },
            { value: 'raw', label: t('fix.includeFileSizes.raw') },
            { value: 'gzip', label: t('fix.includeFileSizes.gzip') },
          ]}
          onChange={(v) => patch({ includeFileSizes: v })}
        />
      </div>
      <Switch label={t('fix.hashFilenames')} hint={t('fix.hashFilenamesHint')} checked={s.hashFilenames} onChange={(b) => patch({ hashFilenames: b })} />
    </Card>
  );
}

// ── Card: Бэкенд (Backend, optional) — the opt-in native-op TOGGLES (page UI). Consent + upload preview +
//    reachability stay in the FixCard next to the Run button (invariant 1/2 — consent is per-run, never
//    sticky, never on this page). Gated on a configured backend (an API base + a stored entitlement token). ──
function BackendCard({ s, patch }: Sect) {
  const { t } = useI18n();
  const configured = API_BASE !== '' && loadStoredEntitlement() != null;
  return (
    <Card title={t('settings.section.backend')}>
      <p className="font-mono text-[13px] leading-relaxed text-ink-soft">{t('fix.backend.hint')}</p>
      {!configured ? (
        <p className="font-mono text-[13px] leading-relaxed text-ink-soft">{t('fix.backend.unconfigured')}</p>
      ) : (
        <>
          <Switch label={t('fix.backend.ktx2')} hint={t('fix.backend.ktx2Hint')} checked={s.ktx2Enable} onChange={(b) => patch({ ktx2Enable: b })} />
          <Switch label={t('fix.backend.pngquant')} hint={t('fix.backend.pngquantHint')} checked={s.pngquantEnable} onChange={(b) => patch({ pngquantEnable: b })} />
          <Switch label={t('fix.backend.resample')} hint={t('fix.backend.resampleHint')} checked={s.resampleEnable} onChange={(b) => patch({ resampleEnable: b })} />
          <p className="border-t border-line pt-2 font-mono text-[13px] leading-relaxed text-ink-soft">{t('settings.backend.consentNote')}</p>
        </>
      )}
    </Card>
  );
}

// ── Card: Конфиг (Config) — save/load the WHOLE BuildSettings as a versioned JSON (build-config v2). Backend
//    toggles + consent are NEVER serialized (build-config whitelist); a load PRESERVES the live backend
//    toggles (they are not read from the file — invariant: opt-in never sticky via a shared config). ──
function ConfigCard({ s }: { s: BuildSettings }) {
  const { t } = useI18n();
  const { replace, settings } = useBuildSettings();
  const [cfgStatus, setCfgStatus] = useState('');
  const cfgInputRef = useRef<HTMLInputElement>(null);
  const onSave = (): void => downloadText(serializeBuildConfig(s), 'asset-doctor-build-config.json');
  const onLoad = (file: File): void => {
    void file.text().then((text) => {
      const res = parseBuildConfig(text);
      if (res.ok) {
        // Apply every serialized field atomically; PRESERVE the live backend-op toggles (never restored from
        // a file — the parse fills them with defaults, but we keep the user's live choices). The transitional
        // `pngRecompress` boolean view rides along on res.state; drop it (BuildSettings has the level).
        const { pngRecompress: _drop, ...loaded } = res.state;
        void _drop;
        replace({ ...loaded, ktx2Enable: settings.ktx2Enable, pngquantEnable: settings.pngquantEnable, resampleEnable: settings.resampleEnable });
        // Older-config warning (never silent): an OLDER file is applied as a full snapshot, so sections that
        // did not exist in its version were backfilled to their defaults (parseBuildConfig/pickSettings) —
        // surface that instead of a bare "loaded" so the user is not surprised by reset packing/rules/output.
        setCfgStatus(t(res.version < BUILD_CONFIG_VERSION ? 'fix.config.loadedOld' : 'fix.config.loaded'));
      } else {
        setCfgStatus(res.detail ? `${t(res.reasonKey)} — ${res.detail}` : t(res.reasonKey));
      }
    });
  };
  return (
    <Card title={t('settings.section.config')}>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onSave} className="rounded border border-line px-2 py-1 font-mono text-[13px] text-teal-text transition hover:border-teal">
          ↓ {t('fix.config.save')}
        </button>
        <button type="button" onClick={() => cfgInputRef.current?.click()} className="rounded border border-line px-2 py-1 font-mono text-[13px] text-teal-text transition hover:border-teal">
          ↑ {t('fix.config.load')}
        </button>
        <input
          ref={cfgInputRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onLoad(f);
            e.target.value = '';
          }}
        />
      </div>
      <p className="font-mono text-[13px] leading-relaxed text-ink-soft">{t('fix.config.hint')}</p>
      {cfgStatus ? (
        <p role="status" aria-live="polite" className="font-mono text-[13px] leading-relaxed text-ink">
          {cfgStatus}
        </p>
      ) : (
        <p role="status" aria-live="polite" className="sr-only" />
      )}
    </Card>
  );
}

// The page shell: back link + focusable h1 + apply-note + the grouped open cards. Rendered INSIDE the same
// <main> landmark as the results tree (App wraps the main tree in a `hidden` sibling), so there is exactly
// ONE <h1> per view. Focus is moved to this h1 on the main→settings swap by App's ONE focus owner (UX-4,
// lib/focus-move.ts) — NOT a local mount effect: only focus-move can also handle the settings→main return
// (SettingsPage is unmounted by then). The frozen id `ad-settings-h1` is the anchor it targets.
export function SettingsPage({
  hasResults,
  hiddenRules,
  onChangeHiddenRules,
}: {
  hasResults: boolean;
  /** The user's finding-type visibility set (view-prefs slice, App-owned + localStorage-durable). */
  hiddenRules: ReadonlySet<Rule>;
  /** Persist + apply a new hidden set (App threads this to saveHiddenRules + state). */
  onChangeHiddenRules: (next: Set<Rule>) => void;
}) {
  const { t } = useI18n();
  const { settings, patch } = useBuildSettings();
  return (
    <div className="space-y-5">
      {/* The back link returns to the main view. Its label is HONEST about the destination: "back to results"
          only when a report exists (the page is reachable pre-analysis from the header nav — there the link
          returns to the empty dropzone, so it says just "back"). */}
      <a href="#" className="inline-block font-mono text-xs text-teal-text underline-offset-2 hover:underline">
        ← {t(hasResults ? 'settings.back' : 'settings.backHome')}
      </a>
      <div>
        <h1 id="ad-settings-h1" tabIndex={-1} className="ad-focus-anchor font-display text-2xl font-semibold tracking-tight">
          {t('settings.title')}
        </h1>
        <p className="mt-2 max-w-xl font-mono text-[13px] leading-relaxed text-ink-soft">{t('settings.applyNote')}</p>
      </div>
      <div className="space-y-4">
        {/* Appearance (theme) FIRST — a durable display pref that applies immediately, sibling to the diagnosis
            view-filter and independent of the build/export cards below. */}
        <ThemeCard />
        {/* The diagnosis-VIEW filter: applies immediately and is separate from the build/export cards below
            (governed by the page-level "applies to the NEXT run" note). */}
        <DiagnosisCard hidden={hiddenRules} onChange={onChangeHiddenRules} />
        <FormatsCard s={settings} patch={patch} />
        <ResolutionsCard s={settings} patch={patch} />
        <PackingCard s={settings} patch={patch} />
        <MipmapsCard s={settings} patch={patch} />
        <RulesCard s={settings} patch={patch} />
        <OutputCard s={settings} patch={patch} />
        <BackendCard s={settings} patch={patch} />
        <ConfigCard s={settings} />
      </div>
    </div>
  );
}
