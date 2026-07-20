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
// No network, no fs, no node: — imports only core/analysis + this package, browser-safe (invariant 1).
// MOVED (P10) from apps/web/src/lib so the CLI can emit the SAME HTML/MD/CSV artifacts (audit --html);
// the web keeps a re-export shim at the old path — one source, zero drift between web and CLI output.

import type { AnalysisReport, Finding, Severity } from '@asset-doctor/core';
import { fmtBytes } from '@asset-doctor/analysis';
import { toJSON } from './serialize';
import { biggestWins, hasWins, type WinRow } from './biggest-wins';

export type ReportFormat = 'json' | 'md' | 'csv' | 'html';
export const REPORT_MIME: Record<ReportFormat, string> = {
  json: 'application/json',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
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
  // "Biggest wins — start here": the SAME ranking the in-app panel shows (biggest-wins.ts), so a shared report
  // names the same top reclaims. TWO separate single-unit lists (disk / VRAM), never summed (invariant 5); a
  // finding appears only when its measured saving on that axis is > 0 (sparse excluded). No total. Omitted when
  // no finding carries an estimate ⇒ the MD is byte-identical to before.
  const w = biggestWins(r);
  if (hasWins(w)) {
    const mdList = (rows: WinRow[]): string[] =>
      rows.map((row) => `- ${fmtBytes(row.bytes)} — ${escMd(row.assetRef)}${row.relatedCount > 0 ? ` (${row.relatedCount} files)` : ''}`);
    L.push('## Biggest wins — start here', '');
    if (w.disk.length > 0) L.push('**Reclaim the most disk:**', ...mdList(w.disk), '');
    if (w.vram.length > 0) L.push('**Reclaim the most VRAM:**', ...mdList(w.vram), '');
  }
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

// HTML — a self-contained styled findings page a non-technical teammate can open in a browser. STRICT
// artifact: inline <style> only, a system-font stack (NO @font-face/url()/remote font), no <script>, no
// <img>, no external CSS/URL — zero fetchable references (invariant 1). No Date() ⇒ deterministic and
// measured-only. Same content surface as MD (summary + disk≠VRAM note + deterministic findings table),
// styled. Injection is the #1 risk: EVERY dynamic value (subject, assetRef, title, detail, scope, and even
// fmtBytes output) is routed through escapeHtml — one uniform rule, zero exceptions.
export function escapeHtml(v: string | number): string {
  return String(v)
    .replace(/&/g, '&amp;') // & FIRST so entities inserted below aren't re-escaped
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;'); // numeric — &apos; isn't valid HTML4
}

const HTML_STYLE = `:root{color-scheme:light}*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem;background:#E7ECF1;color:#16202A;line-height:1.5;
 font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:60rem;margin:0 auto}h1{font-size:1.4rem;margin:0 0 .5rem}
.summary{font-family:ui-monospace,Menlo,Consolas,monospace;margin:0 0 1rem}
.note{background:#FFF;border:1px solid #DCE3EA;border-left:3px solid #2B8FC9;padding:.75rem 1rem;border-radius:6px;font-size:.9rem;color:#566472}
.empty{color:#566472}.wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;background:#FFF;margin-top:1rem}
th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid #DCE3EA;vertical-align:top;font-size:.9rem}
th{background:#F2F5F8}
td.num,th.num{font-family:ui-monospace,Menlo,Consolas,monospace;text-align:right;white-space:nowrap}
td.asset{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all}
.sev{font-weight:600;text-transform:uppercase;font-size:.78rem}
.sev-crit{color:#E5484D}.sev-warn{color:#D98A00}.sev-ok{color:#1F9D63}.sev-info{color:#2B8FC9}
.wins{background:#FFF;border:1px solid #DCE3EA;border-radius:6px;padding:.75rem 1rem;margin:1rem 0}
.wins h2{font-size:1rem;margin:0 0 .5rem}.wins h3{font-size:.82rem;color:#566472;text-transform:uppercase;letter-spacing:.04em;margin:.6rem 0 .3rem}
.wins ul{margin:0;padding-left:1.1rem}.wins li{margin:.15rem 0}
.wins .num{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:600;color:#0E8C8C}
footer{color:#566472;font-size:.85rem;margin-top:1.25rem}`;

export function reportToHTML(r: AnalysisReport, opts: { subject?: string } = {}): string {
  const t = r.totals;
  const floor = t.loadedTextures ?? r.assets.length; // SAME honest floor as MD
  const fs = sortFindings(r.findings); // SAME deterministic order
  const titleText = `Asset Doctor — audit${opts.subject ? `: ${escapeHtml(opts.subject)}` : ''}`;
  const summary =
    `${r.assets.length} assets · disk ${escapeHtml(fmtBytes(t.diskBytes))} · ` +
    `VRAM(loaded) ${escapeHtml(fmtBytes(t.loadedVramBytes))} · draw-call floor ≥ ${floor}`;
  const note = escapeHtml(NOTE.replace('{naive}', fmtBytes(t.vramBytes))); // REUSE the existing NOTE
  // "Biggest wins" section — SAME ranking as MD + the in-app panel (biggest-wins.ts). Two separate single-unit
  // lists, never summed (invariant 5); every dynamic value routed through escapeHtml. Omitted when no estimates.
  const w = biggestWins(r);
  const winLi = (row: WinRow): string =>
    `<li><span class="num">${escapeHtml(fmtBytes(row.bytes))}</span> — <span class="asset">${escapeHtml(row.assetRef)}</span>` +
    `${row.relatedCount > 0 ? ` (${escapeHtml(row.relatedCount)} files)` : ''}</li>`;
  const winsHtml = !hasWins(w)
    ? ''
    : `<section class="wins"><h2>Biggest wins — start here</h2>` +
      (w.disk.length > 0 ? `<h3>Reclaim the most disk</h3><ul>${w.disk.map(winLi).join('')}</ul>` : '') +
      (w.vram.length > 0 ? `<h3>Reclaim the most VRAM</h3><ul>${w.vram.map(winLi).join('')}</ul>` : '') +
      `</section>`;
  const rows = fs
    .map((f) => {
      const d = f.estimate?.diskBytesSaved;
      const v = f.estimate?.vramBytesSaved; // blank, NEVER a fabricated 0
      return (
        `<tr>` +
        // Severity is a closed enum ⇒ class + WORD both safe; the WORD is in the cell ⇒ color not the sole signal.
        `<td><span class="sev sev-${f.severity}">${f.severity}</span></td>` +
        `<td>${escapeHtml(f.scope ?? 'asset')}</td>` +
        `<td class="asset">${escapeHtml(f.assetRef)}</td>` + // #1 injection vector — escaped
        `<td>${escapeHtml(f.title)}</td>` +
        `<td>${escapeHtml(f.detail)}</td>` +
        `<td class="num">${d !== undefined ? escapeHtml(fmtBytes(d)) : ''}</td>` + // disk column
        `<td class="num">${v !== undefined ? escapeHtml(fmtBytes(v)) : ''}</td>` + // SEPARATE vram column
        `</tr>`
      );
    })
    .join('');
  const table =
    fs.length === 0
      ? `<p class="empty">No findings.</p>`
      : `<div class="wrap"><table><thead><tr>` +
        `<th>Severity</th><th>Scope</th><th>Asset</th><th>Finding</th><th>Detail</th>` +
        `<th class="num">Disk saved (est.)</th><th class="num">VRAM saved (est.)</th>` +
        `</tr></thead><tbody>${rows}</tbody></table></div>`;
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${titleText}</title>\n<style>${HTML_STYLE}</style>\n</head>\n<body>\n<main>\n` +
    `<h1>${titleText}</h1>\n<p class="summary">${summary}</p>\n<p class="note">${note}</p>\n` +
    winsHtml +
    table +
    `\n<footer>Generated in-browser by Asset Doctor · ${fs.length} finding${fs.length === 1 ? '' : 's'}.</footer>\n` +
    `</main>\n</body>\n</html>\n`
  );
}

export function reportContent(r: AnalysisReport, fmt: ReportFormat, subject?: string): string {
  return fmt === 'json'
    ? reportToJSON(r)
    : fmt === 'md'
      ? reportToMarkdown(r, { subject })
      : fmt === 'html'
        ? reportToHTML(r, { subject })
        : reportToCSV(r);
}

export function reportFilename(subject: string | undefined, ext: ReportFormat): string {
  const slug = (subject ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'asset'}-audit.${ext}`;
}
