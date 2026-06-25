// Pure serializers/renderers shared by the CLI and the GitHub Action: deterministic JSON (assets
// sorted by ref), SARIF 2.1.0, a job-summary markdown table, GitHub annotation commands, and the
// human audit/gate tables. No IO, no color decisions baked in — the caller passes `color`.

import type { AnalysisReport, Finding, Severity } from '@asset-doctor/core';
import { fmtBytes } from '@asset-doctor/analysis';
import { formatValue } from './evaluate';
import { ASSET_METRICS, GLOBAL_METRICS } from './metrics';
import type { GateEntry, GateResult } from './types';

/* ── colour ──────────────────────────────────────────────────────────── */
const CODES = { reset: 0, dim: 2, red: 31, green: 32, yellow: 33, cyan: 36, gray: 90 } as const;
type Colour = keyof Omit<typeof CODES, 'reset'>;
const paint = (color: boolean) => (c: Colour, s: string): string => (color ? `[${CODES[c]}m${s}[0m` : s);
const SEV_COLOUR: Record<Severity, Colour> = { crit: 'red', warn: 'yellow', ok: 'green', info: 'cyan' };

/* ── determinism ─────────────────────────────────────────────────────── */
export function sortedAssets(report: AnalysisReport): AnalysisReport['assets'] {
  // analyze() leaves report.assets in input (readdir) order; sort for stable JSON/diffs.
  return [...report.assets].sort((a, b) => a.assetRef.localeCompare(b.assetRef));
}

/** Stable order for gate entries in machine output — config key order isn't guaranteed across
 *  formatters (e.g. Prettier may re-sort the budget JSON), and base/head diffs must line up. */
export function sortedEntries(entries: GateEntry[]): GateEntry[] {
  return [...entries].sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      (a.assetRef ?? '').localeCompare(b.assetRef ?? '') ||
      a.key.localeCompare(b.key) ||
      a.level.localeCompare(b.level) ||
      a.check.localeCompare(b.check),
  );
}

// GitHub workflow-command escaping (docs: actions workflow-commands). `data` for the message body,
// `prop` (stricter — also : and ,) for property values like file=.
const escData = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s: string): string => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
// Markdown table cells: escape the pipe and flatten newlines so a `|` in an asset name can't break the row.
const escMd = (s: string | number): string => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const metricLabel = (key: string): string => GLOBAL_METRICS.get(key)?.label ?? ASSET_METRICS.get(key)?.label ?? key;

export const CAPABILITY_NOTE =
  'measured: VRAM (w×h×4), disk, oversize, NPOT, occupancy, exact-dupes · ' +
  'not measured here (needs the browser/extension): transcode-savings, near-dupes, live draw calls';

/* ── machine outputs ─────────────────────────────────────────────────── */
export function toJSON(report: AnalysisReport, gate?: GateResult): unknown {
  return {
    version: 1,
    capabilities: gate?.capabilities,
    totals: report.totals,
    drawCallsLowerBound: report.assets.length,
    thresholds: report.thresholds,
    assets: sortedAssets(report),
    findings: report.findings,
    ...(gate
      ? { gate: { worst: gate.worst, errorCount: gate.errorCount, warnCount: gate.warnCount, entries: sortedEntries(gate.entries) } }
      : {}),
  };
}

export function toSARIF(gate: GateResult): unknown {
  const breaches = gate.entries.filter((e) => e.status !== 'pass');
  return {
    version: '2.1.0',
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'asset-doctor',
            rules: [...new Set(breaches.map((b) => b.key))].map((id) => ({
              id,
              name: id,
              shortDescription: { text: `Asset budget: ${metricLabel(id)}` },
            })),
          },
        },
        results: breaches.map((b) => ({
          ruleId: b.key,
          level: b.status === 'error' ? 'error' : 'warning',
          message: { text: b.message },
          locations: [{ physicalLocation: { artifactLocation: { uri: b.assetRef ?? '.' } } }],
        })),
      },
    ],
  };
}

/** Worst-first ordering for annotations / comments: errors first, then by overage magnitude. */
function worstFirst(entries: GateEntry[]): GateEntry[] {
  const breaches = entries.filter((e) => e.status !== 'pass');
  const over = (e: GateEntry): number => (e.budget > 0 ? Math.abs(e.value - e.budget) / e.budget : e.value);
  return breaches.sort((a, b) => (a.status === b.status ? over(b) - over(a) : a.status === 'error' ? -1 : 1));
}

/** GitHub workflow annotation commands (::error / ::warning), capped, worst-first. */
export function toAnnotations(gate: GateResult, limit = 10): string[] {
  return worstFirst(gate.entries)
    .slice(0, limit)
    .map((e) => {
      const cmd = e.status === 'error' ? 'error' : 'warning';
      const file = e.assetRef ? ` file=${escProp(e.assetRef)}` : '';
      return `::${cmd}${file}::asset-doctor: ${escData(e.message)}`;
    });
}

/* ── job summary (markdown) ──────────────────────────────────────────── */
const ICON = { pass: '✅', warn: '⚠️', error: '❌' } as const;
function row(cells: (string | number)[]): string {
  return `| ${cells.map(escMd).join(' | ')} |`;
}

export function toSummaryMarkdown(report: AnalysisReport, gate: GateResult, opts: { dir?: string } = {}): string {
  const lines: string[] = [];
  lines.push(`### ${ICON[gate.worst]} Asset Doctor — budget ${gate.worst === 'pass' ? 'passed' : gate.worst === 'warn' ? 'passed with warnings' : 'failed'}`);
  if (opts.dir) lines.push(`\`${opts.dir}\` · ${report.assets.length} assets · disk ${fmtBytes(report.totals.diskBytes)} · VRAM(loaded) ${fmtBytes(report.totals.loadedVramBytes)}`);
  lines.push('');
  if (gate.entries.length === 0) {
    lines.push('_No budgets configured — advisory run._');
  } else {
    lines.push(row(['', 'Metric', 'Scope', 'Budget', 'Value', 'Δ vs base']));
    lines.push(row(['---', '---', '---', '---', '---', '---']));
    for (const e of gate.entries) {
      const delta = e.deltaPct !== undefined ? `${e.deltaPct >= 0 ? '+' : ''}${e.deltaPct}%` : e.baseValue !== undefined ? `${formatValue(e.unit, e.value - e.baseValue)}` : '—';
      lines.push(row([ICON[e.status], `\`${e.key}\``, e.assetRef ?? 'global', `${e.check} ${formatValue(e.unit, e.budget)}`, formatValue(e.unit, e.value), delta]));
    }
  }
  lines.push('');
  lines.push(`<sub>${CAPABILITY_NOTE}</sub>`);
  return lines.join('\n');
}

/* ── human terminal output ───────────────────────────────────────────── */
function findingLine(f: Finding, c: ReturnType<typeof paint>): string {
  const tag = c(SEV_COLOUR[f.severity], `[${f.severity}]`.padEnd(6));
  const scope = f.scope === 'folder' ? c('gray', '(folder) ') : '';
  return `  ${tag} ${scope}${f.title}  ${c('gray', f.assetRef)}`;
}

export function renderReport(report: AnalysisReport, opts: { color?: boolean; dir?: string } = {}): string {
  const c = paint(opts.color ?? false);
  const t = report.totals;
  const out: string[] = [];
  out.push(c('cyan', '▣ Asset Doctor — audit') + (opts.dir ? c('gray', `  ${opts.dir}`) : ''));
  out.push(`  ${report.assets.length} assets · disk ${c('cyan', fmtBytes(t.diskBytes))} · VRAM summed ${fmtBytes(t.vramBytes)} → loaded ${c('cyan', fmtBytes(t.loadedVramBytes))}`);
  out.push(c('gray', `  disk weight ≠ GPU footprint: VRAM = Σ w×h×4. draw calls ≥ ${report.assets.length} (one per distinct texture).`));
  const findings = report.findings;
  out.push('');
  if (findings.length === 0) out.push(c('green', '  ✓ no findings'));
  else for (const f of findings) out.push(findingLine(f, c));
  out.push('');
  out.push(c('gray', `  ${CAPABILITY_NOTE}`));
  return out.join('\n');
}

export function renderGate(report: AnalysisReport, gate: GateResult, opts: { color?: boolean; dir?: string } = {}): string {
  const c = paint(opts.color ?? false);
  const out: string[] = [];
  out.push(c('cyan', '▣ Asset Doctor — budget') + (opts.dir ? c('gray', `  ${opts.dir}`) : ''));
  out.push(`  ${report.assets.length} assets · disk ${fmtBytes(report.totals.diskBytes)} · VRAM(loaded) ${fmtBytes(report.totals.loadedVramBytes)}`);
  out.push('');
  if (gate.entries.length === 0) {
    out.push(c('gray', '  no budgets configured — advisory only'));
  } else {
    for (const e of gate.entries) {
      const mark = e.status === 'error' ? c('red', '✗') : e.status === 'warn' ? c('yellow', '!') : c('green', '✓');
      out.push(`  ${mark} ${e.message}`);
    }
  }
  out.push('');
  const banner =
    gate.worst === 'error'
      ? c('red', `✗ budget FAILED — ${gate.errorCount} error${gate.errorCount === 1 ? '' : 's'}, ${gate.warnCount} warning${gate.warnCount === 1 ? '' : 's'}`)
      : gate.worst === 'warn'
        ? c('yellow', `! budget passed with ${gate.warnCount} warning${gate.warnCount === 1 ? '' : 's'}`)
        : c('green', '✓ budget passed');
  out.push('  ' + banner);
  out.push(c('gray', `  ${CAPABILITY_NOTE}`));
  return out.join('\n');
}
