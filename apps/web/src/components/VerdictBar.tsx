import type { Severity } from '@asset-doctor/core';
import { useI18n } from '../lib/i18n';
import { DOT, TXT } from './Findings';
import type { TriageIndex } from '../lib/triage';

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
}: {
  /** Finding counts per severity, from buildIndex (already O(1) — no scan here). */
  tally: TriageIndex['tally'];
  /** The currently-kept severities (the ledger filter). A chip is "pressed" when its severity is kept. */
  severityFilter: Set<Severity>;
  /** Toggle one severity in/out of the filter. */
  onToggle: (sev: Severity) => void;
}) {
  const { t } = useI18n();
  const problemCount = tally.crit + tally.warn + tally.info;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-4">
      <h2 className="font-display text-lg font-semibold text-ink">{t('triage.verdict')}</h2>
      {problemCount === 0 ? (
        <span className="flex items-center gap-2 font-mono text-xs text-ok">
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
                <span className={pressed ? TXT[sev] : ''}>{t(`triage.filter.${sev}`, { n: tally[sev] })}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
