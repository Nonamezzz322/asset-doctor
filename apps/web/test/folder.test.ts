import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Asset, ImageFeatures } from '@asset-doctor/core';
import { parseImage } from '@asset-doctor/parsers';
import { analyze } from '@asset-doctor/analysis';
import { groupFiles, type RawFile } from '../src/lib/group';

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/sample-projects/folder-waste',
);
const baseOf = (p: string): string => p.split('/').pop() ?? p;

function load(): RawFile[] {
  return readdirSync(ROOT)
    .filter((n) => statSync(join(ROOT, n)).isFile())
    .map((n) => ({ name: n, bytes: new Uint8Array(readFileSync(join(ROOT, n))).buffer }));
}

// Mirrors the worker's folder pipeline headlessly: group → parse → SHA features → analyze.
// (dHash needs a canvas, so duplicate-similar is covered by analysis unit tests + the live run.)
describe('folder-level pipeline over the folder-waste fixture', () => {
  it('detects exact duplicates, loose-sprite atlasing, and a missing image', async () => {
    const grouped = groupFiles(load());
    expect(grouped.missing).toEqual([{ manifest: 'broken.json', image: 'missing.png' }]);

    const assets: Asset[] = [];
    const features: ImageFeatures[] = [];
    for (const im of grouped.images) {
      const name = baseOf(im.name);
      const r = parseImage(name, new Uint8Array(im.bytes));
      if (!r.ok) continue;
      assets.push(r.asset);
      features.push({
        assetRef: name,
        contentHash: createHash('sha256').update(Buffer.from(im.bytes)).digest('hex'),
      });
    }

    const report = await analyze(assets, undefined, { features, missingImages: grouped.missing });
    const byRule = (rule: string) => report.findings.filter((f) => f.rule === rule);

    const dup = byRule('duplicate-exact').find((f) => f.relatedRefs?.includes('dup_a.png'));
    expect(dup?.relatedRefs).toEqual(['dup_a.png', 'dup_b.png']);
    expect(byRule('should-atlas')).toHaveLength(1);
    expect(byRule('should-atlas')[0]?.relatedRefs).toHaveLength(11);
    expect(byRule('integrity-missing-image')[0]?.severity).toBe('crit');
    expect(byRule('integrity-missing-image')[0]?.relatedRefs).toContain('missing.png');
    expect(report.totals.potentialDiskSaved).toBeGreaterThan(0); // the duplicate copy
  });
});
