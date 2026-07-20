// `audit <dir>` — measure & report only, never fails on findings (exit 0 unless the dir is bad).
// Local readout, and the command the Action runs on the base ref to produce the baseline JSON.

import type { AnalysisReport, Severity } from '@asset-doctor/core';
import { ConfigError, renderReport, reportToHTML, reportToMarkdown, reportToCSV, toJSON } from '@asset-doctor/budget';
import { auditDir } from '../pipeline';
import type { IO } from '../io';
import { type Flags, validateDir, writeFileAbs } from './common';

const RANK: Record<Severity, number> = { crit: 0, warn: 1, info: 2, ok: 3 };

function filterFindings(report: AnalysisReport, severity?: string): AnalysisReport {
  if (!severity) return report;
  const max = RANK[severity as Severity];
  if (max === undefined) return report;
  return { ...report, findings: report.findings.filter((f) => RANK[f.severity] <= max) };
}

export async function auditCmd(dirArg: string, flags: Flags, io: IO): Promise<number> {
  // --json/--html/--md/--csv are exclusive machine formats for the SAME measured report — fail-closed on
  // an ambiguous combination instead of silently picking one (exit 2, ConfigError convention).
  if (Number(flags.json) + Number(flags.html) + Number(flags.md) + Number(flags.csv) > 1) {
    throw new ConfigError('--json, --html, --md, and --csv are mutually exclusive');
  }
  const dir = validateDir(dirArg, io);
  const { report } = await auditDir(dir);
  const view = filterFindings(report, flags.severity);
  // --html/--md/--csv emit the SAME serializers the web export buttons build (one shared source in
  // @asset-doctor/budget — zero drift; MD/HTML carry the biggest-wins section). With any of them, --out
  // writes the artifact (the CI use); without a format flag, --out keeps writing JSON exactly as before
  // (non-breaking: these flags did not exist).
  if (flags.html) {
    const html = reportToHTML(view, { subject: dirArg });
    if (flags.out) writeFileAbs(flags.out, html, io);
    else io.out(html);
    return 0;
  }
  if (flags.md) {
    const md = reportToMarkdown(view, { subject: dirArg });
    if (flags.out) writeFileAbs(flags.out, md, io);
    else io.out(md);
    return 0;
  }
  if (flags.csv) {
    const csv = reportToCSV(view);
    if (flags.out) writeFileAbs(flags.out, csv, io);
    else io.out(csv);
    return 0;
  }
  const json = JSON.stringify(toJSON(view), null, 2);
  if (flags.out) writeFileAbs(flags.out, json, io);
  if (flags.json) io.out(json);
  else if (!flags.quiet) io.out(renderReport(view, { color: io.color, dir: dirArg }));
  return 0;
}
