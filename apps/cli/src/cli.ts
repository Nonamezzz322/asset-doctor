// Entry point: parse argv (Node util.parseArgs, zero-dep), dispatch to a command, map results to
// exit codes. 0 pass/advisory · 1 budget exceeded · 2 config/usage · 3 input · 4 internal. Commands
// return a code (never call process.exit) so they stay unit-testable; this shell does the exiting.

import { parseArgs } from 'node:util';
import { ConfigError } from '@asset-doctor/budget';
import { InputError } from './errors';
import { realIO } from './io';
import { auditCmd } from './commands/audit';
import { budgetCmd } from './commands/budget';
import { initCmd } from './commands/init';
import type { Flags } from './commands/common';

const VERSION = '0.1.0';
const HELP = `asset-doctor — static asset budget gate for HTML5 games (PixiJS/Phaser)

Usage:
  asset-doctor audit  <dir> [--json] [--out file] [--severity crit|warn|info] [--quiet]
  asset-doctor budget <dir> [--config file] [--baseline file] [--json] [--out file]
                            [--sarif file] [--summary file] [--annotate]
                            [--fail-on error|warn|none] [--warn-only] [--quiet]
  asset-doctor init   <dir> [--out file] [--force]

Reads PNG/WebP/JPEG/AVIF + TexturePacker/Pixi/Spine manifests, never uploads. Measures disk, VRAM
(w×h×4), occupancy, oversize/NPOT, should-atlas, exact-dupes; transcode-savings / near-dupes / live
draw calls need the browser build and are disclosed, not silently passed.

Exit: 0 pass/advisory · 1 budget exceeded · 2 config/usage · 3 input · 4 internal`;

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        baseline: { type: 'string' },
        json: { type: 'boolean', default: false },
        sarif: { type: 'string' },
        out: { type: 'string' },
        summary: { type: 'string' },
        annotate: { type: 'boolean', default: false },
        severity: { type: 'string' },
        'warn-only': { type: 'boolean', default: false },
        'fail-on': { type: 'string', default: 'error' },
        quiet: { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
    });
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
  const { values, positionals } = parsed;

  if (values.version) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(HELP + '\n');
    return command ? 0 : 2;
  }

  const failOn = String(values['fail-on'] ?? 'error');
  if (failOn !== 'error' && failOn !== 'warn' && failOn !== 'none') {
    throw new ConfigError(`--fail-on must be error|warn|none, got "${failOn}"`);
  }

  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const flags: Flags = {
    config: str(values.config),
    baseline: str(values.baseline),
    json: Boolean(values.json),
    sarif: str(values.sarif),
    out: str(values.out),
    summary: str(values.summary),
    annotate: Boolean(values.annotate),
    severity: str(values.severity),
    warnOnly: Boolean(values['warn-only']),
    failOn,
    quiet: Boolean(values.quiet),
    force: Boolean(values.force),
  };

  const io = realIO();
  if (values['no-color']) io.color = false;
  const dir = positionals[1] ?? '.';

  switch (command) {
    case 'audit':
      return auditCmd(dir, flags, io);
    case 'budget':
      return budgetCmd(dir, flags, io);
    case 'init':
      return initCmd(dir, flags, io);
    default:
      process.stderr.write(`unknown command "${command}" (expected audit|budget|init)\n`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    if (e instanceof ConfigError) {
      process.stderr.write(`config error: ${e.message}${e.path ? ` (at ${e.path})` : ''}\n`);
      process.exit(2);
    }
    if (e instanceof InputError) {
      process.stderr.write(`input error: ${e.message}\n`);
      process.exit(3);
    }
    process.stderr.write(`internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(4);
  });
