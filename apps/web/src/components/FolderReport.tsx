import type { Finding } from '@asset-doctor/core';
import { SEVERITY_RING, SEVERITY_TEXT } from '../lib/format';

// Whole-folder findings (duplicates, should-atlas, atlas-merge, integrity, format aggregate).
// Each lists the assets it spans; clicking one jumps the viewer to that asset.
export function FolderReport({
  findings,
  onPick,
}: {
  findings: Finding[];
  onPick: (assetRef: string) => void;
}) {
  if (findings.length === 0) return null;
  return (
    <section className="rounded-lg border border-line bg-panel p-4">
      <div className="flex items-baseline gap-2">
        <h2 className="font-display text-lg font-semibold">Folder report</h2>
        <span className="font-mono text-xs text-ink-soft">
          {findings.length} whole-folder issue{findings.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {findings.map((f) => (
          <li key={f.id} className="rounded-md border border-line p-3">
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
            {f.relatedRefs && f.relatedRefs.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {f.relatedRefs.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => onPick(r)}
                    className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-soft hover:border-teal"
                  >
                    {r}
                  </button>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
