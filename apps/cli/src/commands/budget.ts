// `budget <dir>` — the gate. Same pipeline as audit, then evaluates the report against the budget
// config and sets the exit code. No config → advisory (exit 0, prints a "not gating" notice so a
// green check never quietly means "no gate". --out/--sarif/--summary/--annotate emit CI surfaces.

import {
  evaluateGate,
  parseBudgetConfig,
  renderGate,
  renderReport,
  toAnnotations,
  toJSON,
  toSARIF,
  toSummaryMarkdown,
} from '@asset-doctor/budget';
import { auditDir } from '../pipeline';
import { discoverConfig } from '../discover';
import type { IO } from '../io';
import { type Flags, appendFileAbs, loadBaseline, validateDir, writeFileAbs } from './common';

export async function budgetCmd(dirArg: string, flags: Flags, io: IO): Promise<number> {
  const dir = validateDir(dirArg, io);
  const discovered = discoverConfig({ ...(flags.config ? { configFlag: flags.config } : {}), cwd: io.cwd });

  if (!discovered) {
    const { report } = await auditDir(dir);
    if (!flags.quiet && !flags.json) io.out(renderReport(report, { color: io.color, dir: dirArg }));
    io.err('no asset-doctor.budget.json found — not gating (run `asset-doctor init`). Exit 0.');
    return 0;
  }

  const config = parseBudgetConfig(discovered.raw);
  if (!flags.quiet) io.err(`config: ${discovered.path} (${discovered.source})`);
  const { report, assetSizes } = await auditDir(dir, config);
  const baseline = flags.baseline ? loadBaseline(flags.baseline, io) : undefined;
  const gate = evaluateGate(report, config, { ...(baseline ? { baseline } : {}), assetSizes });

  const json = JSON.stringify(toJSON(report, gate), null, 2);
  if (flags.out) writeFileAbs(flags.out, json, io);
  if (flags.sarif) writeFileAbs(flags.sarif, JSON.stringify(toSARIF(gate), null, 2), io);
  if (flags.summary) appendFileAbs(flags.summary, toSummaryMarkdown(report, gate, { dir: dirArg }), io);
  if (flags.json) io.out(json);
  else if (!flags.quiet) io.out(renderGate(report, gate, { color: io.color, dir: dirArg }));
  if (flags.annotate) for (const line of toAnnotations(gate)) io.out(line);

  if (flags.warnOnly || flags.failOn === 'none') return 0;
  if (flags.failOn === 'warn') return gate.worst !== 'pass' ? 1 : 0;
  return gate.errorCount > 0 ? 1 : 0;
}
