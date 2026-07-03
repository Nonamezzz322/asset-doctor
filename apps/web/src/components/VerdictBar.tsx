import type { Severity } from '@asset-doctor/core';
import { useI18n } from '../lib/i18n';
import { DOT } from './Findings';
import type { TriageIndex } from '../lib/triage';
import { skippedChipModel } from '../lib/skipped-chip';
import { severityLabelClass } from '../lib/severity-style';

// Thin summary header below the app chrome: the verdict word + a row of severity-tally chips that
// double as FILTER toggles. The chips show REAL finding counts straight off the precomputed index's
// tally (invariant 3 — only measured numbers, never fabricated); clicking one adds/removes that
// severity from the active filter (aria-pressed reflects the toggle state for a11y). `info` is shown
// only when it has findings — an empty info chip is noise. STATIC dots (no ad-pulse-dot): this header
// is always mounted, but we keep the chrome calm and reserve the pulse for the film scanline + the
// selected detail card. The four totals (disk/vram/measured/saveable) stay in the app <header>; this
// bar deliberately does NOT repeat the saveable number (round11 correction #4).

// Order the chips worst→best so the eye lands on crit first; `ok` never gets a tally chip (clean is the
// absence of a problem, surfaced by the ledger's "show N clean" toggle instead).
const CHIP_SEVERITIES: Exclude<Severity, 'ok'>[] = ['crit', 'warn', 'info'];

export function VerdictBar({
  tally,
  severityFilter,
  onToggle,
  skippedCount = 0,
  onSkippedJump,
}: {
  /** Finding counts per severity, from buildIndex (already O(1) — no scan here). */
  tally: TriageIndex['tally'];
  /** The currently-kept severities (the ledger filter). A chip is "pressed" when its severity is kept. */
  severityFilter: Set<Severity>;
  /** Toggle one severity in/out of the filter. */
  onToggle: (sev: Severity) => void;
  /** report.unparsed.length — files that could not be analyzed. 0 ⇒ no chip. NOT a severity, never counted
   *  into problemCount, never joins the tally chips (UX-4). */
  skippedCount?: number;
  /** Jump command: open + anchor-scroll to the UnparsedNotice disclosure. Chip is inert without it. */
  onSkippedJump?: () => void;
}) {
  const { t } = useI18n();
  const problemCount = tally.crit + tally.warn + tally.info;
  // "Could not analyze" chip — a jump command, NOT a filter/severity: dashed warn-toned border, no
  // aria-pressed, never counted into problemCount. Renders in ALL done-phase report states (including the
  // assets=0 + unparsed=N case, where "no issues found" + "N files skipped" side by side is the honest story).
  const chip = onSkippedJump ? skippedChipModel(skippedCount, t) : null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-4">
      <h2 className="font-display text-lg font-semibold text-ink">{t('triage.verdict')}</h2>
      {problemCount === 0 ? (
        <span className={`flex items-center gap-2 font-mono text-xs ${severityLabelClass()}`}>
          <span className="h-2 w-2 rounded-full bg-ok" /> {t('triage.allClear')}
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {CHIP_SEVERITIES.map((sev) => {
            if (tally[sev] === 0) return null;
            const pressed = severityFilter.has(sev);
            return (
              <button
                key={sev}
                type="button"
                aria-pressed={pressed}
                onClick={() => onToggle(sev)}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-xs transition ${
                  pressed ? 'border-teal bg-panel text-ink' : 'border-line text-ink-soft hover:border-ink-soft'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${DOT[sev]} ${pressed ? '' : 'opacity-40'}`} />
                {/* The word inherits the button's own AA-safe color (pressed text-ink / unpressed
                    text-ink-soft); the hue lives only on the dot above (WCAG 1.4.1). */}
                {t(`triage.filter.${sev}`, { n: tally[sev] })}
              </button>
            );
          })}
        </div>
      )}
      {chip ? (
        // ml-auto right-aligns it; flex-wrap drops it to its own line on narrow widths (the row's gap-y-2
        // handles the wrap). Warn arrives via the decorative dot + border/bg tint ONLY — the label text is
        // text-ink (AA); text-warn (#D98A00 ≈ 2.6:1 on #FFF) must never carry text. The sr-only hint suffix
        // is INSIDE the button so the accessible name = "N files skipped — jump to the skipped-files list"
        // (visible label is a prefix, WCAG 2.5.3). No aria-pressed (a jump command, not a toggle).
        <button
          type="button"
          onClick={onSkippedJump}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-dashed border-warn/50 bg-warn/5 px-2.5 py-1 font-mono text-xs text-ink transition hover:border-warn"
        >
          <span className="h-2 w-2 rounded-full bg-warn" aria-hidden />
          {chip.label}
          <span className="ad-sr-only"> — {chip.hint}</span>
        </button>
      ) : null}
    </div>
  );
}
