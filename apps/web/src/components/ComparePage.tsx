// V4 runtime A/B compare surface (#compare) — load two LIVE session recordings (BEFORE applying the Pro
// fix and AFTER shipping the fixed assets), attest the workload comparability, and see the per-metric
// deltas. ALL decision logic is in the pure Node-tested lib/compare-view.ts + packages/correlate core;
// this is a THIN renderer (results-summary/budget-strip precedent). HONESTY (invariant 3): the core
// refuses delta verdicts per class/gate and this page NEVER re-enables one — device (timing) rows are
// WITHHELD without the same-device attestation, incomparable rows show raw values + a hedge, never a
// causal claim. Session JSONs are read locally (FileReader); nothing leaves the device.

import { useMemo, useState, useId } from 'react';
import type { RuntimeReport } from '@asset-doctor/probe/runtime';
import { compareRuntimeReports, parseSessionRuntime, COMPARE_DEFAULTS } from '@asset-doctor/correlate';
import { compareView } from '../lib/compare-view';
import { useI18n } from '../lib/i18n';
import { fmtBytes } from '../lib/format';

/** One loaded session slot: its report + a fail-closed load error. */
interface Slot {
  report: RuntimeReport | null;
  error: boolean;
}
const EMPTY: Slot = { report: null, error: false };

function SessionInput({ label, slot, onLoad }: { label: string; slot: Slot; onLoad: (s: Slot) => void }) {
  const { t } = useI18n();
  const id = useId();
  const pick = (file: File | undefined): void => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch {
        onLoad({ report: null, error: true });
        return;
      }
      const report = parseSessionRuntime(parsed);
      onLoad(report ? { report, error: false } : { report: null, error: true });
    };
    reader.onerror = () => onLoad({ report: null, error: true });
    reader.readAsText(file);
  };
  return (
    <div className="rounded-2xl border border-line bg-panel p-4">
      <label htmlFor={id} className="ad-label block text-ink-soft">
        {label}
      </label>
      <input
        id={id}
        type="file"
        accept="application/json,.json"
        onChange={(e) => pick(e.target.files?.[0])}
        className="mt-2 block w-full font-mono text-xs text-ink-soft file:mr-3 file:rounded file:border file:border-line file:bg-bg file:px-2.5 file:py-1 file:font-mono file:text-xs file:text-teal-text hover:file:border-teal"
      />
      {slot.error ? (
        <p role="alert" className="mt-2 font-mono text-[11px] text-crit-text">
          {t('compare.error')}
        </p>
      ) : slot.report ? (
        <p className="mt-2 font-mono text-[11px] text-ink-soft">
          {t('compare.session.summary', { frames: slot.report.frames, ms: slot.report.durationMs })}
        </p>
      ) : null}
    </div>
  );
}

/** Signed, class-aware rendering of a comparable delta (bytes vs plain count). Direction rides the sign;
 *  NO good/bad color — we report the measured change, we never assert it was caused by the fix. */
function deltaText(bytes: boolean, value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  return sign + (bytes ? fmtBytes(Math.abs(value)) : `${Math.abs(value)}`);
}

export function ComparePage() {
  const { t } = useI18n();
  const [before, setBefore] = useState<Slot>(EMPTY);
  const [after, setAfter] = useState<Slot>(EMPTY);
  const [sameScene, setSameScene] = useState(false);
  const [sameDevice, setSameDevice] = useState(false);

  const view = useMemo(() => {
    if (!before.report || !after.report) return null;
    const c = compareRuntimeReports(before.report, after.report, COMPARE_DEFAULTS, { sameDevice });
    return compareView(c, { sameDevice });
  }, [before.report, after.report, sameDevice]);

  const cell = (bytes: boolean, v: number): string => (bytes ? fmtBytes(v) : `${v}`);

  return (
    <section aria-labelledby="ad-compare-h1" className="mx-auto max-w-4xl">
      <h1 id="ad-compare-h1" tabIndex={-1} className="ad-focus-anchor font-display text-3xl font-semibold tracking-tight text-ink">
        {t('compare.title')}
      </h1>
      <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">{t('compare.subtitle')}</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <SessionInput label={t('compare.load.before')} slot={before} onLoad={setBefore} />
        <SessionInput label={t('compare.load.after')} slot={after} onLoad={setAfter} />
      </div>

      {/* Workload attestation — the honesty inputs. Same-scene gates the per-frame reading (never our
          measurement); same-device UNHIDES the device/timing rows entirely (withheld by default). */}
      <fieldset className="mt-5 rounded-2xl border border-line bg-panel p-4">
        <legend className="ad-label px-1 text-ink-soft">{t('compare.attest.legend')}</legend>
        <p className="mb-2 font-mono text-[11px] leading-relaxed text-ink-soft">{t('compare.attest.hint')}</p>
        <label className="flex items-center gap-2 font-mono text-[13px] text-ink-soft">
          <input type="checkbox" checked={sameScene} onChange={(e) => setSameScene(e.target.checked)} className="h-4 w-4" />
          {t('compare.attest.scene')}
        </label>
        <label className="mt-1.5 flex items-center gap-2 font-mono text-[13px] text-ink-soft">
          <input type="checkbox" checked={sameDevice} onChange={(e) => setSameDevice(e.target.checked)} className="h-4 w-4" />
          {t('compare.attest.device')}
        </label>
      </fieldset>

      {view ? (
        <div className="mt-6">
          {/* verdict banner + measured comparability facts */}
          <div className="rounded-2xl border border-line bg-panel p-4">
            <p className="font-mono text-sm text-ink">{t(view.verdictKey)}</p>
            <p className="mt-1 font-mono text-[11px] text-ink-soft">
              {t('compare.sessions.line', {
                fa: view.frames.before, fb: view.frames.after,
                da: view.durationMs.before, db: view.durationMs.after,
                skew: Math.round(view.durationSkewPct * 100),
              })}
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-ink-soft">
              {t('compare.hitches', { before: view.hitches.before, after: view.hitches.after })}
            </p>
          </div>

          <div className="mt-3 overflow-x-auto rounded-2xl border border-line bg-panel">
            <table className="w-full font-mono text-[13px]">
              <thead>
                <tr className="border-b border-line text-ink-soft">
                  <th scope="col" className="px-3 py-2 text-left font-normal">{t('compare.col.metric')}</th>
                  <th scope="col" className="px-3 py-2 text-right font-normal">{t('compare.col.before')}</th>
                  <th scope="col" className="px-3 py-2 text-right font-normal">{t('compare.col.after')}</th>
                  <th scope="col" className="px-3 py-2 text-right font-normal">{t('compare.col.delta')}</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((r) => (
                  <tr key={r.key} className="border-b border-line/60 last:border-0">
                    <th scope="row" className="px-3 py-2 text-left font-normal text-ink-soft">{t(r.labelKey)}</th>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">{cell(r.bytes, r.before)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">{cell(r.bytes, r.after)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-soft">
                      {r.delta ? deltaText(r.bytes, r.delta.value) + (r.delta.pct !== undefined ? ` (${r.delta.pct > 0 ? '+' : ''}${r.delta.pct}%)` : '') : t(r.hedgeKey!)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {view.timingWithheld ? (
            <p className="mt-2 px-1 font-mono text-[11px] leading-relaxed text-ink-soft">{t('compare.timingWithheld')}</p>
          ) : null}
        </div>
      ) : (
        <p className="mt-6 rounded-2xl border border-line bg-panel p-4 font-mono text-sm text-ink-soft">
          {t('compare.empty')}
        </p>
      )}
    </section>
  );
}
