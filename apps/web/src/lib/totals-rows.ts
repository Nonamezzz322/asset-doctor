// PURE, Node-testable builder for the sub-md (mobile) totals strip. The four headline totals render
// ONLY inside the desktop header block (App.tsx, classed `hidden ... md:flex`), so on any viewport
// <768px a finished analysis shows NO headline metric — the disk≠VRAM honesty pin (invariant 5) and
// the saveable instant-wow payoff are 100% invisible exactly where space is tightest. This builder is
// the value/label assembly the mobile strip maps over; the render glue (md:hidden swap, JSX) lives in
// App.tsx (not Node-testable), but the probe gate + honesty labelling + savedPct edge cases — the part
// most worth pinning — are extracted here.
//
// HONESTY (invariant 5 — load-bearing):
//   • DECLARED (`loadedVramBytes`) and MEASURED (`probe.vramBytes`) are SEPARATE quantities with DISTINCT
//     labels. The declared row uses the existing self-disambiguating key `readout.declared`
//     ("vram (declared)") — NOT the bare `metric.vram` ("vram") the desktop header uses. The header
//     relies on visual adjacency to the measured chip to disambiguate; on the mobile strip the measured
//     chip is CONDITIONAL (probe gate), so a bare "vram" standing alone could be misread as "the vram",
//     eroding the very honesty we're restoring. `readout.declared` keeps the two textually distinct
//     regardless of whether the measured chip is present, with zero new strings.
//   • MEASURED is read straight from `totals.probe.vramBytes` — NEVER a savings delta.
//   • SAVEABLE is the disk-only %/bytes, identical to the header (`metric.saveable`, accent).
// DETERMINISM: order is a fixed literal array; the probe branch is a single boolean gate; savedPct is
//   integer Math.round. Same inputs → identical output. O(1), independent of asset count.

import type { AnalysisReport } from '@asset-doctor/core';

export interface TotalRow {
  key: string;
  label: string;
  value: string;
  accent?: boolean;
  title?: string;
}

/** Build the fixed-order rows for the mobile totals strip:
 *  `[disk, declared(readout.declared), measured?(only when totals.probe), saveable(accent)]`.
 *  Returns `[]` when `totals` is undefined (report null ⇒ strip not rendered). */
export function buildTotalsRows(
  totals: AnalysisReport['totals'] | undefined,
  // The params type matches the app's bound translator `T` (FindingParams = Record<string, string|number>)
  // so the real `t` from useI18n() is assignable here. This builder passes NO params (key-only lookups),
  // but the signature stays compatible — a stub `(k) => k` satisfies it in Node tests.
  t: (k: string, p?: Record<string, string | number>) => string,
  fmtBytes: (n: number) => string,
): TotalRow[] {
  if (!totals) return [];

  // savedPct mirrors App.tsx exactly (share the formula); the pure fn computes it internally so the
  // 0-disk branch is tested (no NaN — disk-only %, never a VRAM ratio).
  const savedPct = totals.diskBytes > 0 ? Math.round((totals.potentialDiskSaved / totals.diskBytes) * 100) : 0;

  const rows: TotalRow[] = [
    { key: 'disk', label: t('metric.disk'), value: fmtBytes(totals.diskBytes) },
    { key: 'declared', label: t('readout.declared'), value: fmtBytes(totals.loadedVramBytes) },
  ];

  // MEASURED — additive, same gate as the header: present only once the render-probe has run. The REAL
  // decoded footprint (probe.vramBytes), a different quantity from the declared estimate above — never a delta.
  if (totals.probe) {
    rows.push({
      key: 'measured',
      label: t('metric.vramMeasured'),
      value: fmtBytes(totals.probe.vramBytes),
      title: t('readout.measuredTooltip'),
    });
  }

  rows.push({
    key: 'saveable',
    label: t('metric.saveable'),
    value: `${fmtBytes(totals.potentialDiskSaved)} · ${savedPct}%`,
    accent: true,
  });

  return rows;
}
