import type { Finding, Severity } from '@asset-doctor/core';
import { useI18n } from '../lib/i18n';

export const DOT: Record<Severity, string> = { crit: 'bg-crit', warn: 'bg-warn', ok: 'bg-ok', info: 'bg-info' };
export const TXT: Record<Severity, string> = { crit: 'text-crit', warn: 'text-warn', ok: 'text-ok', info: 'text-info' };

export function Findings({
  findings,
  selectedId,
  onSelect,
}: {
  findings: Finding[];
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
}) {
  const { t, renderFinding } = useI18n();
  if (findings.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-panel p-4 font-mono text-sm text-ok">
        <span className="h-2 w-2 rounded-full bg-ok" /> {t('findings.none')}
      </div>
    );
  }
  return (
    <ul className="space-y-2.5">
      {findings.map((f) => {
        const selected = f.id === selectedId;
        const r = renderFinding(f);
        return (
          <li key={f.id}>
            <button
              type="button"
              onClick={() => onSelect(selected ? undefined : f.id)}
              className={`ad-reveal w-full rounded-xl border bg-panel p-4 text-left transition ${
                selected ? 'border-teal ring-1 ring-teal/40' : 'border-line hover:border-ink-soft'
              }`}
            >
              <div className="mb-2 flex items-center gap-2">
                <span className={`ad-pulse-dot h-2 w-2 rounded-full ${DOT[f.severity]}`} />
                <span className={`font-mono text-[10px] uppercase tracking-[0.06em] ${TXT[f.severity]}`}>{t(`severity.${f.severity}`)}</span>
              </div>
              <h3 className="font-display text-[15px] font-semibold leading-snug text-ink">{r.title}</h3>
              <p className="mt-1 text-[13px] leading-snug text-ink-soft">{r.detail}</p>
              {r.fix ? <p className="mt-2 font-mono text-xs text-teal">→ {r.fix}</p> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
