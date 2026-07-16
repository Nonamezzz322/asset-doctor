// Shared command plumbing: parsed flags, dir validation (→ InputError/exit 3), graceful baseline
// loading (a missing/garbled baseline disables deltas but never fails the run), and file writers.

import { existsSync, statSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AnalysisReport } from '@asset-doctor/core';
import { InputError } from '../errors';
import type { IO } from '../io';

export interface Flags {
  config?: string;
  baseline?: string;
  json: boolean;
  /** `audit` only: emit the self-contained HTML report (mutually exclusive with --json; --out writes it). */
  html: boolean;
  sarif?: string;
  out?: string;
  summary?: string;
  annotate: boolean;
  severity?: string;
  warnOnly: boolean;
  failOn: 'error' | 'warn' | 'none';
  /** `diff` only: opt-in regression gate on a NEW/worsened finding. Ignored by audit/budget/init. */
  failOnNew?: string;
  quiet: boolean;
  force: boolean;
}

export function validateDir(dir: string, io: IO): string {
  const abs = resolve(io.cwd, dir);
  if (!existsSync(abs)) throw new InputError(`directory not found: ${dir}`);
  if (!statSync(abs).isDirectory()) throw new InputError(`not a directory: ${dir}`);
  return abs;
}

/** Load a prior audit JSON as a baseline report. Degrades gracefully — never throws. */
export function loadBaseline(path: string, io: IO): AnalysisReport | undefined {
  try {
    const json = JSON.parse(readFileSync(resolve(io.cwd, path), 'utf8')) as Record<string, unknown>;
    if (json && json.totals && Array.isArray(json.assets) && Array.isArray(json.findings)) {
      return json as unknown as AnalysisReport;
    }
    io.err(`baseline ${path} is not an audit JSON — ignoring (deltas disabled)`);
  } catch (e) {
    io.err(`baseline ${path} unavailable (${(e as Error).message}) — ignoring (deltas disabled)`);
  }
  return undefined;
}

export function writeFileAbs(target: string, content: string, io: IO): void {
  writeFileSync(resolve(io.cwd, target), content.endsWith('\n') ? content : content + '\n');
}

export function appendFileAbs(target: string, content: string, io: IO): void {
  appendFileSync(resolve(io.cwd, target), content + '\n');
}
