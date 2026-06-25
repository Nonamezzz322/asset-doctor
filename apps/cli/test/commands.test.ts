import { afterAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@asset-doctor/budget';
import { auditCmd } from '../src/commands/audit';
import { budgetCmd } from '../src/commands/budget';
import { initCmd } from '../src/commands/init';
import { InputError } from '../src/errors';
import type { Flags } from '../src/commands/common';
import type { IO } from '../src/io';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const FIX = 'fixtures/sample-projects';
const tmp = mkdtempSync(join(tmpdir(), 'ad-cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function fakeIO(): { io: IO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { cwd: REPO, out: (s) => out.push(s), err: (s) => err.push(s), color: false }, out, err };
}
const FLAGS: Flags = { json: false, annotate: false, warnOnly: false, failOn: 'error', quiet: true, force: false };
const cfgFile = (name: string, body: object): string => {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
};

describe('command exit codes', () => {
  it('audit never fails on findings (exit 0)', async () => {
    const { io } = fakeIO();
    expect(await auditCmd(`${FIX}/tp-array-oversize`, FLAGS, io)).toBe(0);
  });

  it('budget returns 1 when an error budget is breached', async () => {
    const config = cfgFile('tight.json', { version: 1, budgets: { 'findings.crit': { error: { max: 0 } } } });
    const { io } = fakeIO();
    expect(await budgetCmd(`${FIX}/tp-array-oversize`, { ...FLAGS, config }, io)).toBe(1);
  });

  it('budget returns 0 when within budget', async () => {
    const config = cfgFile('loose.json', { version: 1, budgets: { 'findings.crit': { error: { max: 5 } } } });
    const { io } = fakeIO();
    expect(await budgetCmd(`${FIX}/pixi-packed-ok`, { ...FLAGS, config }, io)).toBe(0);
  });

  it('warn-only clamps a would-be failure to 0', async () => {
    const config = cfgFile('crit.json', { version: 1, budgets: { 'findings.crit': { error: { max: 0 } } } });
    const { io } = fakeIO();
    expect(await budgetCmd(`${FIX}/tp-array-oversize`, { ...FLAGS, config, warnOnly: true }, io)).toBe(0);
  });

  it('no config → advisory exit 0 with a "not gating" notice', async () => {
    const { io, err } = fakeIO();
    expect(await budgetCmd(`${FIX}/single-images`, FLAGS, io)).toBe(0);
    expect(err.join(' ')).toMatch(/not gating/);
  });

  it('a browser-only metric is a ConfigError (→ exit 2)', async () => {
    const config = cfgFile('browser.json', { version: 1, budgets: { 'findings.format': { error: { max: 0 } } } });
    const { io } = fakeIO();
    await expect(budgetCmd(`${FIX}/folder-waste`, { ...FLAGS, config }, io)).rejects.toBeInstanceOf(ConfigError);
  });

  it('a bad directory is an InputError (→ exit 3)', async () => {
    const { io } = fakeIO();
    await expect(budgetCmd(`${FIX}/nope`, FLAGS, io)).rejects.toBeInstanceOf(InputError);
  });

  it('init writes a config and refuses to overwrite without --force', async () => {
    const out = join(tmp, 'asset-doctor.budget.json');
    const { io } = fakeIO();
    expect(await initCmd(`${FIX}/folder-waste`, { ...FLAGS, out }, io)).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(await initCmd(`${FIX}/folder-waste`, { ...FLAGS, out }, io)).toBe(2); // exists, no --force
    expect(await initCmd(`${FIX}/folder-waste`, { ...FLAGS, out, force: true }, io)).toBe(0);
  });

  it('a baseline that grew past maxDeltaPct fails (degrades gracefully if missing)', async () => {
    const config = cfgFile('delta.json', { version: 1, budgets: { 'totals.diskBytes': { error: { maxDeltaPct: 10 } } } });
    // build a baseline with half the disk so HEAD looks like +100% growth
    const { io: io0 } = fakeIO();
    const base = join(tmp, 'base.json');
    await auditCmd(`${FIX}/single-images`, { ...FLAGS, json: true, out: base }, io0);
    const j = JSON.parse(readFileSync(base, 'utf8'));
    j.totals.diskBytes = Math.round(j.totals.diskBytes / 2);
    writeFileSync(base, JSON.stringify(j));
    const { io } = fakeIO();
    expect(await budgetCmd(`${FIX}/single-images`, { ...FLAGS, config, baseline: base }, io)).toBe(1);
    // a missing baseline disables deltas but never fails the run
    const { io: io2 } = fakeIO();
    expect(await budgetCmd(`${FIX}/single-images`, { ...FLAGS, config, baseline: join(tmp, 'nope.json') }, io2)).toBe(0);
  });
});
