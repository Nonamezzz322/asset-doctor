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
      report.findings.filter((f) => f.assetRef === ref).map((f) => `${f.rule}:${f.severity}`).sort();

    expect(verdicts('symbols.png')).toEqual(['occupancy:crit', 'wasted-regions:info']);
    expect(verdicts('sheet.png')).toEqual(['dimensions-npot:warn', 'dimensions-oversize:crit']);
    expect(verdicts('packed.png')).toEqual([]);
    expect(verdicts('hero.png')).toEqual(['dimensions-npot:warn', 'dimensions-oversize:warn']);
    expect(report.totals.vramBytes).toBeGreaterThan(0);
    expect(report.assets).toHaveLength(5);
  });
});
