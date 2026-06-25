import type { Finding } from '@asset-doctor/core';
import { SEVERITY_RING, SEVERITY_TEXT } from '../lib/format';

export function Findings({
  findings,
  selectedId,
  onSelect,
}: {
  findings: Finding[];
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
}) {
  if (findings.length === 0) {
    return <p className="font-mono text-sm text-ok">✓ no issues for this asset</p>;
  }
  return (
    <ul className="space-y-2">
      {findings.map((f) => {
        const selected = f.id === selectedId;
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
                  {f.severity}
                </span>
                <span className="font-mono text-sm text-ink">{f.title}</span>
              </div>
              <p className="mt-1 text-xs text-ink-soft">{f.detail}</p>
              {f.fix ? <p className="mt-1 font-mono text-xs text-teal">→ {f.fix}</p> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
