import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Asset } from '@asset-doctor/core';
import { parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { analyze } from '@asset-doctor/analysis';
import { groupFiles, type RawFile } from '../src/lib/group';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/sample-projects/spine-basic');
const raw = (name: string): RawFile => ({
  name,
  path: name,
  bytes: new Uint8Array(readFileSync(join(DIR, name))).buffer,
});

describe('Spine .atlas pipeline (group → parseSpinePage → analyze)', () => {
  it('groups a .atlas, parses its page, and analyzes it', async () => {
    const g = groupFiles([raw('sheet.atlas'), raw('sheet.png')]);
    expect(g.atlases).toHaveLength(1);
    expect(g.atlases[0]!.kind).toBe('spine');
    expect(g.missing).toEqual([]);
    expect(g.images).toEqual([]); // the page image is claimed by the atlas, not loose

    const a = g.atlases[0]!;
    const r = parseSpinePage(a.manifest as SpinePage, { ref: a.name, bytes: new Uint8Array(a.image.bytes) });
    expect(r.ok).toBe(true);
    if (!r.ok || r.asset.kind !== 'atlas') throw new Error('expected atlas');
    expect(r.asset.atlas.source.kind).toBe('spine');
    expect(r.asset.atlas.sprites).toHaveLength(2);

    const report = await analyze([r.asset] as Asset[]);
    // ~16% packed ⇒ the occupancy finding fires; on a 256² page the ~220 KB waste sits under
    // occupancy.minWastedBytes (256 KB) so the fractional crit demotes to info (severity-only).
    expect(report.findings.some((f) => f.rule === 'occupancy' && f.severity === 'info')).toBe(true);
    expect(report.assets[0]!.vramBytes).toBe(256 * 256 * 4);
  });
});
