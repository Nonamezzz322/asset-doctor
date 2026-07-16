import { describe, it, expect } from 'vitest';
import type { Asset } from '@asset-doctor/core';
import { parseAtlas, parseImage } from '@asset-doctor/parsers';
import { analyze, mergeSharedAtlases } from '@asset-doctor/analysis';
import { groupFiles, keyOf, type RawFile } from '../src/lib/group';
import { b64ToBytes } from '../src/lib/demo';
import { DEMO_FILES } from '../src/demo/demo-data';

// P4 landing demo button — the bundled demo project must actually DEMONSTRATE the product: every file
// parses (a demo with skip-warnings would look broken), the headless pipeline (group → parse → analyze,
// the same shape the worker runs) yields a diverse multi-severity diagnosis, and the payload decodes
// byte-faithfully. Feature-gated rules (solid-fill, duplicate-exact, premultiplied…) need the worker's
// pixel features and are NOT asserted here — the fixtures' goldens already document them; this guards
// the demo's baseline value without pinning threshold-sensitive exact sets.

describe('demo project (P4) — the bundled sample must parse clean and diagnose richly', () => {
  const files: RawFile[] = DEMO_FILES.map((f) => ({
    name: f.path.split('/').pop() ?? f.path,
    path: f.path,
    bytes: b64ToBytes(f.b64),
  }));

  it('payload integrity: all paths under demo-project/, unique, PNG magic on every image', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(new Set(files.map((f) => f.path)).size).toBe(files.length);
    for (const f of files) {
      expect(f.path.startsWith('demo-project/'), f.path).toBe(true);
      if (f.name.endsWith('.png')) {
        const sig = new Uint8Array(f.bytes.slice(0, 4));
        expect([...sig], `${f.path} PNG magic`).toEqual([0x89, 0x50, 0x4e, 0x47]);
      }
    }
  });

  it('every file parses (no unparsed noise) and the diagnosis is diverse with a crit headline', async () => {
    const grouped = groupFiles(files);
    expect(grouped.missing).toHaveLength(0);
    expect(grouped.skipped ?? []).toHaveLength(0);
    const assets: Asset[] = [];
    for (const a of grouped.atlases) {
      const res = parseAtlas(a.manifest, { ref: a.name, bytes: new Uint8Array(a.image.bytes) }, { name: a.name });
      expect(res.ok, `atlas ${a.name} must parse`).toBe(true);
      if (res.ok && res.asset.kind === 'atlas') assets.push(res.asset);
    }
    for (const im of grouped.images) {
      const res = parseImage(keyOf(im), new Uint8Array(im.bytes));
      expect(res.ok, `image ${keyOf(im)} must parse`).toBe(true);
      if (res.ok && res.asset.kind === 'image') assets.push(res.asset);
    }
    expect(assets.length).toBeGreaterThanOrEqual(6); // 2 atlases + 4+ loose images

    const report = await analyze(mergeSharedAtlases(assets));
    const rules = new Set(report.findings.map((f) => f.rule));
    // Even WITHOUT the worker's pixel features the demo shows a diverse diagnosis…
    expect(rules.size).toBeGreaterThanOrEqual(3);
    // …with a crit headline (the stale-manifest sheet: declared size ≠ real decoded pixels).
    expect(report.findings.some((f) => f.severity === 'crit')).toBe(true);
    expect(rules.has('dimension-mismatch')).toBe(true);
  });
});
