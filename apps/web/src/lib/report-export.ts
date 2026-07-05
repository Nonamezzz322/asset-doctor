// Export / share the diagnosis. THREE serializers over the ALREADY-MEASURED AnalysisReport — the ONLY
// decision logic (App.tsx is a thin renderer that wires these to a Blob download + clipboard):
//   • JSON  — the budget package's toJSON VERBATIM (no gate). Byte-identical to `asset-doctor audit --json`
//             for the same folder ⇒ a cross-tool diff feature with ZERO drift. Invents nothing.
//   • MD    — a purpose-built findings table for humans / PR bodies (fmtBytes human units).
//   • CSV   — RFC4180 machine rows (RAW integer bytes).
// HONESTY: these ONLY read fields that already ride on the measured report (totals/findings/assets/
// thresholds/estimate). They COMPUTE no new metric — fmtBytes only FORMATS an existing byte count,
// sortFindings only REORDERS. Disk-saved and VRAM-saved stay SEPARATE columns/fields, never summed
// (invariant 5); blank (never 0-fabricated) when a finding's estimate lacks that field (invariant 3).
// No network, no fs, no node: — imports only core/analysis/budget, all browser-safe (invariant 1).

import type { AnalysisReport, Finding, Severity } from '@asset-doctor/core';
import { fmtBytes } from '@asset-doctor/analysis';
import { toJSON } from '@asset-doctor/budget';

export type ReportFormat = 'json' | 'md' | 'csv';
export const REPORT_MIME: Record<ReportFormat, string> = {
  json: 'application/json',
  md: 'text/markdown',
  csv: 'text/csv',
};

// Deterministic order for HUMAN/TABULAR exports so shared reports diff cleanly. (JSON stays
// budget-verbatim — findings unsorted — for exact CLI byte-parity.)
const SEV_RANK: Record<Severity, number> = { crit: 0, warn: 1, info: 2, ok: 3 };
export function sortFindings(f: readonly Finding[]): Finding[] {
  return [...f].sort(
    (a, b) =>
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      a.assetRef.localeCompare(b.assetRef) ||
      a.rule.localeCompare(b.rule) ||
      a.id.localeCompare(b.id),
  );
}

// JSON — budget serializer VERBATIM (no gate). Zero drift, invents nothing.
export function reportToJSON(r: AnalysisReport): string {
  return JSON.stringify(toJSON(r), null, 2) + '\n';
}

const NOTE =
  'Disk bytes and VRAM (w×h×4) are separate quantities — never summed. ' +
  'VRAM(loaded) is one variant per asset; the full naive Σ w×h×4 is {naive}. ' +
  'Savings are estimates from the in-browser re-encode.';
// Markdown table cells: escape the pipe and flatten newlines so a `|` in an asset name can't break the row.
const escMd = (s: string | number): string => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function reportToMarkdown(r: AnalysisReport, opts: { subject?: string } = {}): string {
  const t = r.totals;
  const floor = t.loadedTextures ?? r.assets.length;
  const L: string[] = [];
  L.push(`# Asset Doctor — audit${opts.subject ? `: ${opts.subject}` : ''}`, '');
  L.push(
    `${r.assets.length} assets · disk ${fmtBytes(t.diskBytes)} · VRAM(loaded) ${fmtBytes(t.loadedVramBytes)} · draw-call floor ≥ ${floor}`,
    '',
  );
  L.push('> ' + NOTE.replace('{naive}', fmtBytes(t.vramBytes)), '');
  const fs = sortFindings(r.findings);
  if (fs.length === 0) {
    L.push('_No findings._');
  } else {
    L.push('| Severity | Scope | Asset | Finding | Detail | Disk saved (est.) | VRAM saved (est.) |');
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const f of fs) {
      const d = f.estimate?.diskBytesSaved;
      const v = f.estimate?.vramBytesSaved;
      L.push(
        `| ${escMd(f.severity)} | ${escMd(f.scope ?? 'asset')} | ${escMd(f.assetRef)} | ${escMd(f.title)} | ${escMd(f.detail)} | ${d !== undefined ? fmtBytes(d) : ''} | ${v !== undefined ? fmtBytes(v) : ''} |`,
      );
    }
  }
  L.push('', `_Generated in-browser by Asset Doctor · ${fs.length} finding${fs.length === 1 ? '' : 's'}._`);
  return L.join('\n') + '\n';
}

const CSV_HEADER = [
  'severity',
  'scope',
  'asset',
  'relatedRefs',
  'title',
  'detail',
  'fix',
  'diskSavedBytes',
  'vramSavedBytes',
  'occupancyPct',
];
const csvCell = (v: string | number | undefined): string => {
  if (v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function reportToCSV(r: AnalysisReport): string {
  const rows = [CSV_HEADER.join(',')];
  for (const f of sortFindings(r.findings)) {
    rows.push(
      [
        f.severity,
        f.scope ?? 'asset',
        f.assetRef,
        (f.relatedRefs ?? []).join(' '),
        f.title,
        f.detail,
        f.fix,
        f.estimate?.diskBytesSaved,
        f.estimate?.vramBytesSaved,
        f.estimate?.occupancyPct,
      ].map(csvCell).join(','),
    );
  }
  return rows.join('\r\n') + '\r\n'; // RFC4180 CRLF
}

export function reportContent(r: AnalysisReport, fmt: ReportFormat, subject?: string): string {
  return fmt === 'json' ? reportToJSON(r) : fmt === 'md' ? reportToMarkdown(r, { subject }) : reportToCSV(r);
}

export function reportFilename(subject: string | undefined, ext: ReportFormat): string {
  const slug = (subject ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'asset'}-audit.${ext}`;
}
