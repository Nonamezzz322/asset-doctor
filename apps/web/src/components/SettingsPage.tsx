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

import { useRef, useState, type ReactNode } from 'react';
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

// ── Shared card chrome — the "open card" replacement for the old <details>. Tokens only: rounded-xl border
//    border-line bg-panel p-4 + a mono [10px] uppercase teal section title (design §5.2). ──
function Card({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="rounded-xl border border-line bg-panel p-4 text-left">
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
    <label className="flex items-center justify-between gap-2 font-mono text-[10px] text-ink-soft" title={hint}>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step ?? 1}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink focus:border-teal"
      />
    </label>
  );
}

function CheckRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={hint}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-teal" />
      {label}
    </label>
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
      <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('settings.theme.intro')}</p>
      <fieldset className="rounded border border-line/70 p-2">
        <legend className="px-1 ad-label text-ink-soft">{t('settings.theme.legend')}</legend>
        <div className="mt-1 space-y-1">
          {options.map(({ v, label }) => (
            <label key={v} className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft">
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
      <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('settings.diagnosis.intro')}</p>
      <div className="flex items-center justify-between gap-2">
        {/* Live hidden-count — role=status so a screen reader hears it change as boxes toggle (design §9). */}
        <p role="status" aria-live="polite" className="font-mono text-[10px] text-ink-soft">
          {t('settings.diagnosis.hiddenSummary', { n: hiddenCount })}
        </p>
        {/* One-click "show all types" reset — the card-level escape (mirrors the ledger H-line's clear).
            Disabled (not removed) when nothing is hidden ⇒ a stable, discoverable control. */}
        <button
          type="button"
          disabled={hiddenCount === 0}
          onClick={() => onChange(new Set())}
          className="shrink-0 rounded border border-line px-2 py-0.5 font-mono text-[10px] text-teal-text transition hover:border-teal disabled:opacity-60 disabled:hover:border-line"
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
                  <label key={r} className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft">
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
      <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.profile.hint')}</p>

      {/* Defaults (profile OFF path) — replaces the two old buildOptions hardcodes. */}
      <div className="rounded border border-line/70 p-1.5">
        <label className="flex items-center justify-between gap-2 font-mono text-[10px] text-ink-soft" title={t('settings.defaultTarget.hint')}>
          {t('settings.defaultTarget')}
          <select
            aria-label={t('settings.defaultTarget')}
            value={s.defaultTarget}
            onChange={(e) => patch({ defaultTarget: e.target.value as ExportFormat })}
            className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition hover:border-teal focus:border-teal"
          >
            {FORMAT_KEYS.map(({ mime, key }) => (
              <option key={mime} value={mime}>
                {t(key)}
              </option>
            ))}
          </select>
        </label>
        <div className="mt-1.5">
          <NumberRow label={t('settings.defaultQuality')} value={s.defaultQuality} min={0} max={100} onChange={(n) => patch({ defaultQuality: n })} />
        </div>
      </div>

      <label className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft">
        <input type="checkbox" checked={s.profileEnable} onChange={(e) => patch({ profileEnable: e.target.checked })} className="accent-teal" />
        {t('fix.profile.enable')}
      </label>

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
                    <label className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft">
                      <input type="checkbox" checked={f.enabled} onChange={(e) => patchFormat(mime, { enabled: e.target.checked })} className="accent-teal" />
                      {t(key)}
                    </label>
                    {f.enabled ? (
                      <div className="mt-1.5 space-y-1 pl-4">
                        {!isPng && !f.lossless ? (
                          <label className="flex items-center justify-between font-mono text-[10px] text-ink-soft">
                            <span>
                              {t('fix.profile.quality')} <span className="text-ink">{f.quality}</span>
                            </span>
                            <input type="range" min={0} max={100} step={1} value={f.quality} onChange={(e) => patchFormat(mime, { quality: Number(e.target.value) })} className="ml-2 w-1/2 accent-teal" />
                          </label>
                        ) : null}
                        <label className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={isAvif ? t('fix.profile.avifNoLossless') : undefined}>
                          <input type="checkbox" checked={!isAvif && f.lossless} disabled={isAvif} onChange={(e) => patchFormat(mime, { lossless: e.target.checked })} className="accent-teal disabled:opacity-60" />
                          {t('fix.profile.lossless')}
                        </label>
                        {isPng ? (
                          <label className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.profile.pngLossyHint')}>
                            <input type="checkbox" checked={!!f.pngLossy} onChange={(e) => patchFormat(mime, { pngLossy: e.target.checked })} className="accent-teal" />
                            {t('fix.profile.pngLossy')}
                          </label>
                        ) : null}
                        {mime === 'image/webp' && !f.lossless ? (
                          <label className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft">
                            <input type="checkbox" checked={f.near} onChange={(e) => patchFormat(mime, { near: e.target.checked })} className="accent-teal" />
                            {t('fix.profile.nearLossless')}
                          </label>
                        ) : null}
                        {isAvif ? <p className="font-mono text-[9px] leading-relaxed text-ink-soft">{t('fix.profile.avifNoLossless')}</p> : null}
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
                className="mt-1 rounded border border-line bg-panel px-1 py-0.5 font-mono text-[10px] text-ink"
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
            <p className="mt-1 font-mono text-[10px] leading-relaxed text-ink-soft">{DEFAULT_SCALE_TIERS.map((tt) => tt.suffix).join('  ')}</p>
            {s.customTiers.map((tt, i) => {
              const validSuffix = isSafeSuffix(tt.suffix);
              return (
                <div key={i} className="mt-1 flex items-center gap-1.5">
                  <span className="font-mono text-[10px] text-ink-soft">{t('fix.profile.tierScale')}</span>
                  <input type="number" min={0.05} max={1} step={0.05} value={tt.scale} aria-label={t('fix.profile.tierScale')} onChange={(e) => patchTier(i, { scale: Number(e.target.value) })} className="w-16 rounded border border-line bg-panel px-1 font-mono text-[10px] text-ink" />
                  <input type="text" value={tt.suffix} aria-label={t('fix.profile.tierSuffix')} onChange={(e) => patchTier(i, { suffix: e.target.value })} placeholder="_540p" className={`w-20 rounded border bg-panel px-1 font-mono text-[10px] text-ink ${validSuffix ? 'border-line' : 'border-crit'}`} />
                  <button type="button" onClick={() => removeTier(i)} className="font-mono text-[10px] text-crit-text hover:underline" aria-label="remove">
                    ✕
                  </button>
                  {!validSuffix ? <span className="font-mono text-[9px] text-crit-text">{t('fix.profile.tierBadSuffix', { suffix: tt.suffix })}</span> : null}
                </div>
              );
            })}
            <button type="button" onClick={addTier} className="mt-1 font-mono text-[10px] text-teal-text hover:underline">
              + {t('fix.profile.addTier')}
            </button>
          </div>

          {/* ── Per-folder overrides ── */}
          <div>
            <p className="ad-label text-ink-soft">{t('fix.profile.overrides')}</p>
            <p className="mt-1 font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.profile.overridesHint')}</p>
            {s.profileOverrides.map((o, i) => (
              <div key={i} className="mt-1 flex flex-wrap items-center gap-1.5">
                <input type="text" value={o.match} onChange={(e) => patchOverride(i, { match: e.target.value })} placeholder={t('fix.profile.overrideMatchPlaceholder')} aria-label={t('fix.profile.overrides')} className="w-28 rounded border border-line bg-panel px-1 font-mono text-[10px] text-ink" />
                <select value={o.mode} aria-label={t('fix.profile.overrides')} onChange={(e) => patchOverride(i, { mode: e.target.value as OverrideMode })} className="rounded border border-line bg-panel px-1 font-mono text-[10px] text-ink">
                  {OVERRIDE_MODE_KEYS.map(({ mode, key }) => (
                    <option key={mode} value={mode}>
                      {t(key)}
                    </option>
                  ))}
                </select>
                {o.mode !== 'lossless' ? (
                  <input type="number" min={0} max={100} step={1} value={o.quality ?? 85} aria-label={t('fix.profile.quality')} onChange={(e) => patchOverride(i, { quality: Number(e.target.value) })} className="w-14 rounded border border-line bg-panel px-1 font-mono text-[10px] text-ink" />
                ) : null}
                <button type="button" onClick={() => removeOverride(i)} className="font-mono text-[10px] text-crit-text hover:underline" aria-label="remove">
                  ✕
                </button>
              </div>
            ))}
            <div className="mt-1 flex flex-wrap gap-3">
              <button type="button" onClick={addFonts444} className="font-mono text-[10px] text-teal-text hover:underline">
                + {t('fix.profile.overrideFonts444')}
              </button>
              <button type="button" onClick={addOverride} className="font-mono text-[10px] text-teal-text hover:underline">
                + {t('fix.profile.addOverride')}
              </button>
            </div>
          </div>

          <ul className="space-y-1 border-t border-line pt-2 font-mono text-[10px] leading-relaxed text-ink-soft">
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
      <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.tier.hint')}</p>
      <NumberRow label={t('settings.maxEdge')} value={s.maxEdge} min={128} max={16384} step={128} onChange={(n) => patch({ maxEdge: n })} />

      <label className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft">
        <input type="checkbox" checked={s.tierEnable} onChange={(e) => patch({ tierEnable: e.target.checked })} className="accent-teal" />
        {t('fix.tier.enable')}
      </label>
      <p className="font-mono text-[10px] leading-relaxed text-ink">⚠ {t('fix.tier.inlineWarn')}</p>

      {s.tierEnable ? (
        <div className="space-y-2">
          <div className="space-y-1">
            {DEFAULT_SCALE_TIERS.map((tier) => {
              const top = tier.scale >= 1;
              return (
                <label key={tier.suffix} title={top ? t('fix.tier.inlineWarn') : undefined} className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft">
                  <input type="checkbox" checked={top || s.tierSuffixes.includes(tier.suffix)} disabled={top} onChange={(e) => toggle(tier.suffix, e.target.checked)} className="accent-teal disabled:opacity-60" />
                  {t(labelKey(tier.suffix))}
                </label>
              );
            })}
          </div>
          <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.tier.diskNote')}</p>
          <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.tier.repackNote')}</p>
          <ul className="space-y-1 border-t border-line pt-2 font-mono text-[10px] leading-relaxed text-ink-soft">
            <li>{t('fix.skipped.whyNoKernel')}</li>
            <li>{t('fix.skipped.whyNoPreBlur')}</li>
            {/* Softened, consent-agnostic tier hint (the per-run consent lives in the FixCard). */}
            {s.resampleEnable ? <li className="text-teal-text">{t('settings.resampleTierHint')}</li> : null}
          </ul>
        </div>
      ) : null}
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

      <CheckRow label={t('fix.polygon')} hint={t('fix.polygonHint')} checked={s.polygon} onChange={(b) => patch({ polygon: b })} />

      {/* Spine sheet-page format (design §0.1). Default 'png' ⇒ runtime-safe today; 'profile' ⇒ Spine
          repack/pack pages follow the profile/legacy target (tier-loop Spine pages stay PNG in v1). */}
      <label className="flex items-center justify-between gap-2 font-mono text-[10px] text-ink-soft" title={t('settings.spineFormat.hint')}>
        {t('settings.spineFormat')}
        <select
          aria-label={t('settings.spineFormat')}
          value={s.spinePageFormat}
          onChange={(e) => patch({ spinePageFormat: e.target.value === 'profile' ? 'profile' : 'png' })}
          className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition hover:border-teal focus:border-teal"
        >
          <option value="png">{t('settings.spineFormat.png')}</option>
          <option value="profile">{t('settings.spineFormat.profile')}</option>
        </select>
      </label>
      <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('settings.spineFormat.hint')}</p>

      <div className="border-t border-line pt-2">
        <CheckRow label={t('fix.pack.enable')} checked={s.packLoose} onChange={(b) => patch({ packLoose: b })} />
        <p className="mt-1 font-mono text-[10px] leading-relaxed text-ink">⚠ {t('fix.pack.inlineWarn')}</p>

        {s.packLoose ? (
          <div className="mt-2 space-y-2">
            <label className="flex items-center justify-between gap-2 font-mono text-[10px] text-ink-soft">
              {t('fix.pack.mode.label')}
              <select aria-label={t('fix.pack.mode.label')} value={s.packMode} onChange={(e) => patch({ packMode: e.target.value as PackMode })} className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition hover:border-teal focus:border-teal">
                {modes.map((m) => (
                  <option key={m} value={m}>
                    {t(`fix.pack.mode.${modeKey[m]}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2 font-mono text-[10px] text-ink-soft">
              {t('fix.pack.grouping.label')}
              <select aria-label={t('fix.pack.grouping.label')} value={s.packGranularity} onChange={(e) => patch({ packGranularity: e.target.value as StaticGranularity })} className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition hover:border-teal focus:border-teal">
                {grans.map((g) => (
                  <option key={g} value={g}>
                    {t(`fix.pack.grouping.${granKey[g]}`)}
                  </option>
                ))}
              </select>
            </label>
            <CheckRow label={t('fix.pack.trim')} checked={s.packTrim} onChange={(b) => patch({ packTrim: b })} />
            <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.pack.spinePng')}</p>
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
      <label className="flex items-center justify-between gap-2 font-mono text-[10px] text-ink-soft">
        {t('fix.extrude')}
        <select aria-label={t('fix.extrude')} title={t('fix.extrudeHint', { px: s.extrude || 1 })} value={s.extrude} onChange={(e) => patch({ extrude: Number(e.target.value) })} className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition hover:border-teal focus:border-teal">
          {opts.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? t('fix.extrude.off') : t('fix.extrude.px', { n })}
            </option>
          ))}
        </select>
      </label>
      <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.extrudeHint', { px: s.extrude || 1 })}</p>
      <p className="border-t border-line pt-2 font-mono text-[10px] leading-relaxed text-ink-soft">{t('settings.mip.copy')}</p>
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
      <CheckRow label={t('fix.merge')} checked={s.aggressive} onChange={(b) => patch({ aggressive: b })} />

      <label className="block font-mono text-[10px] text-ink-soft">
        <span className="flex items-center justify-between" title={t('fix.settings.effortHint')}>
          {t('fix.settings.effort')} <span className="text-ink">{s.effort}</span>
        </span>
        <input type="range" min={0} max={6} step={1} value={s.effort} aria-label={t('fix.settings.effort')} onChange={(e) => patch({ effort: Number(e.target.value) })} className="mt-1 w-full accent-teal" />
      </label>

      <CheckRow label={t('fix.settings.scaleAware')} hint={t('fix.settings.scaleAwareHint')} checked={s.scaleAwareQ} onChange={(b) => patch({ scaleAwareQ: b })} />
      <CheckRow label={t('fix.settings.nearLossless')} hint={t('fix.settings.nearLosslessHint')} checked={s.webpNearLossless} onChange={(b) => patch({ webpNearLossless: b })} />

      {/* PNG lossless-recompress LEVEL (replaces the old boolean; 0 = off, 1..6 oxipng effort). */}
      <label className="flex items-center justify-between gap-2 font-mono text-[10px] text-ink-soft" title={t('settings.pngLevel.hint')}>
        {t('settings.pngLevel')}
        <select aria-label={t('settings.pngLevel')} value={s.pngRecompressLevel} onChange={(e) => patch({ pngRecompressLevel: Number(e.target.value) })} className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition hover:border-teal focus:border-teal">
          {[0, 1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? t('fix.extrude.off') : String(n)}
            </option>
          ))}
        </select>
      </label>

      <CheckRow label={t('fix.settings.opaqueAlpha')} hint={t('fix.settings.opaqueAlphaHint')} checked={s.opaqueAlpha} onChange={(b) => patch({ opaqueAlpha: b })} />
      <CheckRow label={t('fix.settings.bestFormat')} hint={t('fix.settings.bestFormatHint')} checked={s.bestFormatPerImage} onChange={(b) => patch({ bestFormatPerImage: b })} />
      <CheckRow label={t('fix.settings.frameRedundancy')} hint={t('fix.settings.frameRedundancyHint')} checked={s.frameRedundancy} onChange={(b) => patch({ frameRedundancy: b })} />
      <CheckRow label={t('fix.settings.trimMargin')} hint={t('fix.settings.trimMarginHint')} checked={s.trimMargin} onChange={(b) => patch({ trimMargin: b })} />

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
              className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink focus:border-teal"
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
              className="w-14 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink focus:border-teal"
            />
            <button type="button" onClick={() => setOverrides(s.overrides.filter((_, j) => j !== i))} className="font-mono text-[11px] text-ink-soft hover:text-crit-text" aria-label="remove">
              ✕
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setOverrides([...s.overrides, { match: '', quality: 0.85 }])} className="mt-1.5 font-mono text-[10px] text-teal-text underline-offset-2 hover:underline">
          + {t('fix.settings.overrides')}
        </button>
      </div>

      <ul className="space-y-1 border-t border-line pt-2 font-mono text-[10px] leading-relaxed text-ink-soft">
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
      <CheckRow label={t('fix.pixiManifest')} hint={t('fix.pixiManifestHint')} checked={s.emitPixiManifest} onChange={(b) => patch({ emitPixiManifest: b })} />
      <label className="ml-5 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.includeFileSizesHint')}>
        {t('fix.includeFileSizes')}
        <select
          aria-label={t('fix.includeFileSizes')}
          value={s.includeFileSizes}
          disabled={!s.emitPixiManifest}
          onChange={(e) => patch({ includeFileSizes: e.target.value as 'off' | 'raw' | 'gzip' })}
          className="rounded border border-line bg-panel px-1 py-0.5 font-mono text-[10px] text-ink disabled:opacity-60"
        >
          <option value="off">{t('fix.includeFileSizes.off')}</option>
          <option value="raw">{t('fix.includeFileSizes.raw')}</option>
          <option value="gzip">{t('fix.includeFileSizes.gzip')}</option>
        </select>
      </label>
      <CheckRow label={t('fix.hashFilenames')} hint={t('fix.hashFilenamesHint')} checked={s.hashFilenames} onChange={(b) => patch({ hashFilenames: b })} />
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
      <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.backend.hint')}</p>
      {!configured ? (
        <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.backend.unconfigured')}</p>
      ) : (
        <>
          <CheckRow label={t('fix.backend.ktx2')} hint={t('fix.backend.ktx2Hint')} checked={s.ktx2Enable} onChange={(b) => patch({ ktx2Enable: b })} />
          <CheckRow label={t('fix.backend.pngquant')} hint={t('fix.backend.pngquantHint')} checked={s.pngquantEnable} onChange={(b) => patch({ pngquantEnable: b })} />
          <CheckRow label={t('fix.backend.resample')} hint={t('fix.backend.resampleHint')} checked={s.resampleEnable} onChange={(b) => patch({ resampleEnable: b })} />
          <p className="border-t border-line pt-2 font-mono text-[10px] leading-relaxed text-ink-soft">{t('settings.backend.consentNote')}</p>
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
        <button type="button" onClick={onSave} className="rounded border border-line px-2 py-1 font-mono text-[11px] text-teal-text transition hover:border-teal">
          ↓ {t('fix.config.save')}
        </button>
        <button type="button" onClick={() => cfgInputRef.current?.click()} className="rounded border border-line px-2 py-1 font-mono text-[11px] text-teal-text transition hover:border-teal">
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
      <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.config.hint')}</p>
      {cfgStatus ? (
        <p role="status" aria-live="polite" className="font-mono text-[10px] leading-relaxed text-ink">
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
        <p className="mt-2 max-w-xl font-mono text-[11px] leading-relaxed text-ink-soft">{t('settings.applyNote')}</p>
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
