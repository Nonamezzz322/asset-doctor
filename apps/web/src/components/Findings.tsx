import type { Finding } from '@asset-doctor/core';
import { SEVERITY_RING, SEVERITY_TEXT } from '../lib/format';
import { useI18n } from '../lib/i18n';

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
    return <p className="font-mono text-sm text-ok">{t('findings.none')}</p>;
  }
  return (
    <ul className="space-y-2">
      {findings.map((f) => {
        const selected = f.id === selectedId;
        const r = renderFinding(f);
        return (
          <li key={f.id}>
            <button
              type="button"
              onClick={() => onSelect(selected ? undefined : f.id)}
              className={`w-full rounded-md border bg-panel p-3 text-left transition ${
                selected ? `ring-2 ${SEVERITY_RING[f.severity]} border-transparent` : 'border-line hover:border-ink-soft'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ring-1 ${SEVERITY_TEXT[f.severity]} ${SEVERITY_RING[f.severity]}`}
                >
                  {t(`severity.${f.severity}`)}
                </span>
                <span className="font-mono text-sm text-ink">{r.title}</span>
              </div>
              <p className="mt-1 text-xs text-ink-soft">{r.detail}</p>
              {r.fix ? <p className="mt-1 font-mono text-xs text-teal">→ {r.fix}</p> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
