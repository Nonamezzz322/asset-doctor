// `init <dir>` — scaffold asset-doctor.budget.json, refusing to overwrite without --force. Seeds the
// budget from a real scan (disk + loaded-VRAM with headroom) so the very first gate is measured, not
// a guess. findings.crit defaults to error max 0 (no critical assets allowed past the gate).

import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fmtBytes } from '@asset-doctor/analysis';
import type { AnalysisReport } from '@asset-doctor/core';
import { auditDir } from '../pipeline';
import type { IO } from '../io';
import { type Flags, validateDir } from './common';

function ceilMB(bytes: number, headroom = 1.2): string {
  return `${Math.max(1, Math.ceil((bytes * headroom) / (1024 * 1024)))}MB`;
}

function scaffold(report: AnalysisReport): unknown {
  return {
    version: 1,
    budgets: {
      'totals.diskBytes': { error: { max: ceilMB(report.totals.diskBytes), maxDeltaPct: 15 } },
      'totals.loadedVramBytes': { error: { max: ceilMB(report.totals.loadedVramBytes) } },
      'findings.crit': { error: { max: 0 } },
    },
  };
}

export async function initCmd(dirArg: string, flags: Flags, io: IO): Promise<number> {
  const dir = validateDir(dirArg, io);
  const target = resolve(io.cwd, flags.out ?? 'asset-doctor.budget.json');
  if (existsSync(target) && !flags.force) {
    io.err(`${target} already exists — use --force to overwrite`);
    return 2;
  }
  const { report } = await auditDir(dir);
  writeFileSync(target, JSON.stringify(scaffold(report), null, 2) + '\n');
  io.out(`wrote ${target}`);
  io.out(`seeded from ${report.assets.length} assets · disk ${fmtBytes(report.totals.diskBytes)} · VRAM(loaded) ${fmtBytes(report.totals.loadedVramBytes)}`);
  return 0;
}
