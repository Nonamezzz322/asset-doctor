import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Asset } from '@asset-doctor/core';
import { parseAtlas, parseImage } from '@asset-doctor/parsers';
import { analyze } from '@asset-doctor/analysis';
import { groupFiles, type RawFile } from '../src/lib/group';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/sample-projects');
const baseOf = (p: string): string => p.split('/').pop() ?? p;

function walk(dir: string, prefix: string, out: RawFile[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) walk(full, rel, out);
    else out.push({ name: rel, bytes: new Uint8Array(readFileSync(full)).buffer });
  }
}

// Exercises exactly what analyze.worker.ts does (group → parse → analyze), headless —
// the only piece not covered here is OffscreenCanvas WebP sizing (browser-only).
describe('end-to-end pipeline over the real fixtures folder', () => {
  it('groups atlases + images and produces the expected verdicts', async () => {
    const files: RawFile[] = [];
    for (const dir of ['tp-hash-symbols', 'tp-array-oversize', 'pixi-packed-ok', 'single-images']) {
      walk(join(ROOT, dir), dir, files);
    }

    const grouped = groupFiles(files);
    expect(grouped.atlases.map((a) => a.name).sort()).toEqual(['packed.png', 'sheet.png', 'symbols.png']);
    expect(grouped.images.map((i) => baseOf(i.name)).sort()).toEqual(['hero.png', 'icon.png']);

    const assets: Asset[] = [];
    for (const a of grouped.atlases) {
      const r = parseAtlas(a.manifest, { ref: a.name, bytes: new Uint8Array(a.image.bytes) });
      if (r.ok) assets.push(r.asset);
    }
    for (const im of grouped.images) {
      const r = parseImage(baseOf(im.name), new Uint8Array(im.bytes));
      if (r.ok) assets.push(r.asset);
    }

    const report = await analyze(assets);
    const verdicts = (ref: string): string[] =>
      report.findings.filter((f) => f.assetRef === ref && f.scope !== 'folder').map((f) => `${f.rule}:${f.severity}`).sort();

    expect(verdicts('symbols.png')).toEqual(['occupancy:crit', 'wasted-regions:info']);
    expect(verdicts('sheet.png')).toEqual(['dimensions-npot:info', 'dimensions-oversize:crit']);
    expect(verdicts('packed.png')).toEqual([]);
    expect(verdicts('hero.png')).toEqual(['dimensions-npot:info', 'dimensions-oversize:warn']);
    expect(report.totals.vramBytes).toBeGreaterThan(0);
    expect(report.assets).toHaveLength(5);
  });

  // R21 #1 per-frame recovery, through the real group→parse→fan-out→analyze path. Separate `it` (the case
  // above has exact-count assertions). Replicates the worker's malformedFrames fan-out (this file does not
  // thread `unparsed` in the case above). On pre-R21 code parseAtlas would whole-reject sheet.png → zero
  // atlas assets + an atlas-level unparsed entry → this `it` fails; after the change it passes.
  it('per-frame recovery: a bad frame surfaces via unparsed[] while the good frames are still diagnosed', async () => {
    const files: RawFile[] = [];
    walk(join(ROOT, 'atlas-frame-recovery'), 'atlas-frame-recovery', files);
    const grouped = groupFiles(files);
    const assets: Asset[] = [];
    const unparsed = [...grouped.unparsed];
    for (const a of grouped.atlases) {
      const r = parseAtlas(a.manifest, { ref: a.name, bytes: new Uint8Array(a.image.bytes) });
      if (r.ok && r.asset.kind === 'atlas') {
        assets.push(r.asset);
        for (const mf of r.malformedFrames ?? []) unparsed.push({ ref: `${a.name}#${mf.name}`, reason: mf.reason });
      } else if (!r.ok) {
        unparsed.push({ ref: a.name, reason: r.error });
      }
    }
    unparsed.sort((x, y) => x.ref.localeCompare(y.ref));

    const report = await analyze(assets, undefined, { unparsed });
    // The good frames survived as a real atlas asset (the sheet was NOT whole-rejected).
    expect(assets.some((a) => a.kind === 'atlas' && a.atlas.sprites.length > 0)).toBe(true);
    // Each bad frame is surfaced honestly via the `<atlas>#<frame>` ref — never silently dropped.
    expect(report.unparsed).toContainEqual({ ref: 'sheet.png#bad.png', reason: 'invalid frame "bad.png"' });
    expect(report.unparsed).toContainEqual({
      ref: 'sheet.png#over.png',
      reason: 'frame "over.png" extends past atlas 128×128',
    });
  });
});
