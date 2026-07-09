// `diff <before> <after>` — compare TWO audits and emit an HONEST delta: per-metric before→after
// (MEASURED, no thresholds) + findings ADDED / RESOLVED / CHANGED by stable id. Advisory by default
// (exit 0); opt-in `--fail-on-new crit|warn|any` gates on a NEW/worsened finding (never on an
// improvement). Threshold gating stays `budget --baseline`'s job — diff never re-implements budgeting.
//
// Each side resolves polymorphically: a DIRECTORY is audited via the same zero-network Node pipeline;
// a FILE is parsed as an audit JSON (the exact `audit --json --out` / Action ad-base.json artifact,
// validated to carry totals + assets[] + findings[]). Neither/garbled → InputError (exit 3).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ConfigError,
  diffAudits,
  diffToJSON,
  diffToSummaryMarkdown,
  hasRegression,
  renderDiff,
} from '@asset-doctor/budget';
import type { AuditSnapshot } from '@asset-doctor/budget';
import { auditDir } from '../pipeline';
import { InputError } from '../errors';
import type { IO } from '../io';
import { type Flags, appendFileAbs, writeFileAbs } from './common';

/** Resolve a diff operand to an AuditSnapshot: audit a directory, or parse+validate an audit JSON. */
async function resolveSnapshot(arg: string, io: IO): Promise<AuditSnapshot> {
  const abs = resolve(io.cwd, arg);
  if (!existsSync(abs)) throw new InputError(`path not found: ${arg}`);
  if (statSync(abs).isDirectory()) {
    const { report } = await auditDir(abs);
    return report;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new InputError(`${arg} is not valid JSON (${(e as Error).message})`);
  }
  const j = parsed as Record<string, unknown> | null;
  // Same audit-JSON shape check loadBaseline uses — but STRICT here (diff can't compare a non-audit).
  if (j && j.totals && Array.isArray(j.assets) && Array.isArray(j.findings)) {
    return j as unknown as AuditSnapshot;
  }
  throw new InputError(
    `${arg} is not an audit JSON (expected totals + assets[] + findings[]) — produce one with \`asset-doctor audit --json --out\``,
  );
}

export async function diffCmd(
  beforeArg: string | undefined,
  afterArg: string | undefined,
  flags: Flags,
  io: IO,
): Promise<number> {
  if (!beforeArg || !afterArg) {
    io.err('diff needs <before> <after> (each a directory or an `audit --json` file)');
    return 2;
  }
  // Validate the gating flag BEFORE doing work, so a typo fails fast without a scan.
  const level = flags.failOnNew;
  if (level !== undefined && level !== 'crit' && level !== 'warn' && level !== 'any') {
    throw new ConfigError(`--fail-on-new must be crit|warn|any, got "${level}"`);
  }

  const before = await resolveSnapshot(beforeArg, io);
  const after = await resolveSnapshot(afterArg, io);
  const diff = diffAudits(before, after);

  const json = JSON.stringify(diffToJSON(diff), null, 2);
  if (flags.out) writeFileAbs(flags.out, json, io);
  if (flags.summary) appendFileAbs(flags.summary, diffToSummaryMarkdown(diff, { title: `${beforeArg} → ${afterArg}` }), io);
  if (flags.json) io.out(json);
  else if (!flags.quiet) io.out(renderDiff(diff, { color: io.color }));

  // Advisory unless --fail-on-new: a NEW crit/warn finding or a worsened severity flips exit 1.
  if (level === undefined) return 0;
  return hasRegression(diff, level) ? 1 : 0;
}
