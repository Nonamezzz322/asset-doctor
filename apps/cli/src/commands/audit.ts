// `audit <dir>` — measure & report only, never fails on findings (exit 0 unless the dir is bad).
// Local readout, and the command the Action runs on the base ref to produce the baseline JSON.

import type { AnalysisReport, Severity } from '@asset-doctor/core';
import { renderReport, toJSON } from '@asset-doctor/budget';
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
  const dir = validateDir(dirArg, io);
  const { report } = await auditDir(dir);
  const view = filterFindings(report, flags.severity);
  const json = JSON.stringify(toJSON(view), null, 2);
  if (flags.out) writeFileAbs(flags.out, json, io);
  if (flags.json) io.out(json);
  else if (!flags.quiet) io.out(renderReport(view, { color: io.color, dir: dirArg }));
  return 0;
}
