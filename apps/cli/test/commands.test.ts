import { afterAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@asset-doctor/budget';
import { auditCmd } from '../src/commands/audit';
import { budgetCmd } from '../src/commands/budget';
import { diffCmd } from '../src/commands/diff';
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
const FLAGS: Flags = { json: false, html: false, md: false, csv: false, annotate: false, warnOnly: false, failOn: 'error', quiet: true, force: false };
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

  it('audit --html emits the self-contained page to stdout; --out writes it as the artifact (P10)', async () => {
    const { io, out } = fakeIO();
    expect(await auditCmd(`${FIX}/tp-array-oversize`, { ...FLAGS, html: true }, io)).toBe(0);
    const html = out.join('');
    // The SAME serializer the web export button uses (@asset-doctor/budget reportToHTML): self-contained
    // (inline <style>, zero external refs, no <script>) with the honest disk≠VRAM note.
    expect(html).toContain('<style>');
    expect(html).not.toContain('<script');
    expect(html).toContain('Asset Doctor');
    // --out writes the HTML file (the CI-artifact use), nothing printed
    const file = join(tmp, 'report.html');
    const { io: io2, out: out2 } = fakeIO();
    expect(await auditCmd(`${FIX}/tp-array-oversize`, { ...FLAGS, html: true, out: file }, io2)).toBe(0);
    expect(out2.join('')).toBe('');
    expect(readFileSync(file, 'utf8')).toContain('<style>');
  });

  it('audit --json --html is a fail-closed config conflict (exit 2 via ConfigError)', async () => {
    const { io } = fakeIO();
    await expect(auditCmd(`${FIX}/tp-array-oversize`, { ...FLAGS, json: true, html: true }, io)).rejects.toThrow(
      /mutually exclusive/,
    );
  });

  it('audit --md emits the Markdown report (with the biggest-wins section) to stdout; --out writes it', async () => {
    const { io, out } = fakeIO();
    // folder-waste has estimate-bearing findings (byte-dup + npot) ⇒ the wins section is present.
    expect(await auditCmd(`${FIX}/folder-waste`, { ...FLAGS, md: true }, io)).toBe(0);
    const md = out.join('');
    expect(md).toContain('# Asset Doctor'); // SAME serializer the web export button uses (zero drift)
    expect(md).toContain('## Biggest wins — start here');
    expect(md).toContain('| Severity | Scope | Asset |'); // the findings table below the wins section
    // --out writes the MD artifact (the CI / PR-body use), nothing printed
    const file = join(tmp, 'report.md');
    const { io: io2, out: out2 } = fakeIO();
    expect(await auditCmd(`${FIX}/folder-waste`, { ...FLAGS, md: true, out: file }, io2)).toBe(0);
    expect(out2.join('')).toBe('');
    expect(readFileSync(file, 'utf8')).toContain('## Biggest wins — start here');
  });

  it('audit --csv emits RFC4180 finding rows (raw integer bytes) to stdout; --out writes it', async () => {
    const { io, out } = fakeIO();
    expect(await auditCmd(`${FIX}/folder-waste`, { ...FLAGS, csv: true }, io)).toBe(0);
    const csv = out.join('');
    expect(csv).toContain('severity,scope,asset,relatedRefs,title,detail,fix,diskSavedBytes,vramSavedBytes,occupancyPct');
    expect(csv).toContain('\r\n'); // RFC4180 CRLF
    const file = join(tmp, 'report.csv');
    const { io: io2, out: out2 } = fakeIO();
    expect(await auditCmd(`${FIX}/folder-waste`, { ...FLAGS, csv: true, out: file }, io2)).toBe(0);
    expect(out2.join('')).toBe('');
    expect(readFileSync(file, 'utf8')).toContain('severity,scope,asset');
  });

  it('audit --md --csv (and any two formats) are a fail-closed config conflict (exit 2)', async () => {
    const { io } = fakeIO();
    await expect(auditCmd(`${FIX}/folder-waste`, { ...FLAGS, md: true, csv: true }, io)).rejects.toThrow(
      /mutually exclusive/,
    );
    const { io: io2 } = fakeIO();
    await expect(auditCmd(`${FIX}/folder-waste`, { ...FLAGS, json: true, md: true }, io2)).rejects.toThrow(
      /mutually exclusive/,
    );
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

describe('diff command', () => {
  // A minimal-but-valid audit JSON: only totals + assets[] + findings[] are required by the shape check,
  // and diff's metric getters read totals.* / findings / assets.length.
  const TOTALS = { diskBytes: 100, vramBytes: 100, vramBytesMipmapped: 0, loadedVramBytes: 100, loadedVramBytesMipmapped: 0, potentialDiskSaved: 0 };
  const CRIT = { id: 'x:oversize', rule: 'dimensions-oversize', severity: 'crit', assetRef: 'x.png', title: 'oversize', detail: '' };
  const auditJSON = (name: string, findings: object[]): string => cfgFile(name, { totals: TOTALS, assets: [], findings });

  interface DiffShape {
    metrics: { key: string; unit: string; before: number; after: number; delta: number; direction: string }[];
    findings: { added: unknown[]; resolved: unknown[]; changed: unknown[] };
    counts: Record<string, number>;
  }
  const diffJSON = async (a: string, b: string, extra: Partial<Flags> = {}): Promise<{ code: number; json: DiffShape }> => {
    const { io, out } = fakeIO();
    const code = await diffCmd(a, b, { ...FLAGS, json: true, ...extra }, io);
    return { code, json: JSON.parse(out[out.length - 1]!) as DiffShape };
  };

  it('diffs two directories → exit 0 with all metric rows + finding partitions', async () => {
    const { code, json } = await diffJSON(`${FIX}/single-images`, `${FIX}/tp-array-oversize`);
    expect(code).toBe(0);
    expect(json.metrics).toHaveLength(9);
    expect(Array.isArray(json.findings.added)).toBe(true);
    expect(Array.isArray(json.findings.resolved)).toBe(true);
    expect(Array.isArray(json.findings.changed)).toBe(true);
    // two different fixtures ⇒ at least one metric actually moved (measured, not fabricated)
    expect(json.metrics.some((m) => m.direction !== 'flat')).toBe(true);
  });

  it('diffing a directory against itself is all-flat, empty partitions', async () => {
    const { code, json } = await diffJSON(`${FIX}/tp-array-oversize`, `${FIX}/tp-array-oversize`);
    expect(code).toBe(0);
    expect(json.metrics.every((m) => m.direction === 'flat' && m.delta === 0)).toBe(true);
    expect(json.counts).toMatchObject({ added: 0, resolved: 0, changed: 0 });
  });

  it('the directory form and the audit-JSON-file form yield an identical diff', async () => {
    const base = join(tmp, 'parity-base.json');
    const head = join(tmp, 'parity-head.json');
    const { io: i1 } = fakeIO();
    await auditCmd(`${FIX}/single-images`, { ...FLAGS, json: true, out: base }, i1);
    const { io: i2 } = fakeIO();
    await auditCmd(`${FIX}/tp-array-oversize`, { ...FLAGS, json: true, out: head }, i2);
    const fromDirs = await diffJSON(`${FIX}/single-images`, `${FIX}/tp-array-oversize`);
    const fromFiles = await diffJSON(base, head);
    expect(fromFiles.json).toEqual(fromDirs.json);
  });

  it('--fail-on-new crit gates a NEW crit finding (exit 1); default is advisory (exit 0)', async () => {
    const before = auditJSON('fon-before.json', []);
    const after = auditJSON('fon-after.json', [CRIT]);
    expect((await diffJSON(before, after)).code).toBe(0); // advisory by default
    const { io } = fakeIO();
    expect(await diffCmd(before, after, { ...FLAGS, failOnNew: 'crit' }, io)).toBe(1);
  });

  it('--fail-on-new crit never fails on a RESOLVED crit (an improvement, exit 0)', async () => {
    const before = auditJSON('res-before.json', [CRIT]);
    const after = auditJSON('res-after.json', []);
    const { io } = fakeIO();
    expect(await diffCmd(before, after, { ...FLAGS, failOnNew: 'crit' }, io)).toBe(0);
  });

  it('a bad --fail-on-new value is a ConfigError (→ exit 2)', async () => {
    const before = auditJSON('cfg-before.json', []);
    const after = auditJSON('cfg-after.json', [CRIT]);
    const { io } = fakeIO();
    await expect(diffCmd(before, after, { ...FLAGS, failOnNew: 'zzz' }, io)).rejects.toBeInstanceOf(ConfigError);
  });

  it('a non-audit JSON input is an InputError (→ exit 3)', async () => {
    const bad = cfgFile('not-audit.json', {});
    const ok = auditJSON('ok-audit.json', []);
    const { io } = fakeIO();
    await expect(diffCmd(bad, ok, FLAGS, io)).rejects.toBeInstanceOf(InputError);
  });

  it('a missing path is an InputError (→ exit 3)', async () => {
    const { io } = fakeIO();
    await expect(diffCmd(`${FIX}/single-images`, `${FIX}/does-not-exist`, FLAGS, io)).rejects.toBeInstanceOf(InputError);
  });

  it('missing operands is a usage error (exit 2), not a crash', async () => {
    const { io } = fakeIO();
    expect(await diffCmd(`${FIX}/single-images`, undefined, FLAGS, io)).toBe(2);
  });
});
