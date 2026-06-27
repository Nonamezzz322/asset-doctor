// PURE unit coverage for the Feature 4 Spine skeleton verifier (design §5). The verifier is the SINGLE
// source of truth the fix.worker imports — pinning it here means the per-type resolution / skins-shape /
// path-override / linkedmesh-parent / honest-unverified behavior can't drift between the worker and its
// test. Verified against the real production forms: skins is an ARRAY (modern 3.8+) and a legacy OBJECT.

import { describe, it, expect } from 'vitest';
import { scanSkeleton, verifySpineSkeleton } from '../src/index';

// Modern (3.8+) skeleton: skins is an ARRAY of { name, attachments: { slot: { att: {...} } } }. Covers:
//  • a region attachment with NO path override (region name = attachment name),
//  • a region attachment WITH a path override (name ≠ path → the override is the region name),
//  • the SAME region shared across two slots (legitimate — must NOT collide / never flagged),
//  • a mesh attachment (requires a region),
//  • a linkedmesh inheriting its region from its parent mesh,
//  • a clipping attachment (ignored — needs no region).
const modern = {
  skeleton: { spine: '3.8' },
  bones: [{ name: 'root' }],
  slots: [{ name: 'body', bone: 'root' }],
  skins: [
    {
      name: 'default',
      attachments: {
        head: { head: { type: 'region' } }, // region, no path → region name 'head'
        weapon: { sword: { type: 'region', path: 'items/sword' } }, // path override → 'items/sword'
        shieldA: { shield: { type: 'region' } }, // shared region 'shield' …
        shieldB: { shield: { type: 'region' } }, // … same region in another slot (NOT a collision)
        cape: { cape: { type: 'mesh' } }, // mesh → needs region 'cape'
        capeLink: { capeLink: { type: 'linkedmesh', parent: 'cape' } }, // inherits 'cape'
        mask: { mask: { type: 'clipping' } }, // clipping → ignored
      },
    },
  ],
};

describe('scanSkeleton — modern skins array, per-type resolution', () => {
  const scan = scanSkeleton(modern);

  it('is verifiable (recognized shape)', () => {
    expect(scan.unverified).toBe(false);
  });

  it('resolves region/mesh/linkedmesh and ignores clipping', () => {
    const regions = scan.required.map((r) => r.region).sort();
    // head, items/sword (override), shield (x2, shared), cape (mesh), cape (linkedmesh parent). NO 'mask'.
    expect(regions).toEqual(['cape', 'cape', 'head', 'items/sword', 'shield', 'shield']);
    expect(scan.required.some((r) => r.region === 'mask')).toBe(false);
  });

  it('reads the path override (attachment name ≠ region name)', () => {
    const sword = scan.required.find((r) => r.attachment === 'sword');
    expect(sword?.region).toBe('items/sword');
  });

  it('linkedmesh inherits its region from the parent mesh', () => {
    const link = scan.required.find((r) => r.attachment === 'capeLink');
    expect(link?.region).toBe('cape');
  });
});

describe('verifySpineSkeleton — matching against packed region names', () => {
  it('all required regions present → verified, no unmatched', () => {
    const names = new Set(['head', 'items/sword', 'shield', 'cape']);
    const v = verifySpineSkeleton(modern, names);
    expect(v.unverified).toBe(false);
    expect(v.verified).toBe(6); // head + items/sword + shield + shield + cape(mesh) + cape(linkedmesh)
    expect(v.unmatched).toEqual([]);
  });

  it('a missing region → surfaced in unmatched (atlas not silently broken)', () => {
    const names = new Set(['head', 'shield', 'cape']); // items/sword NOT packed
    const v = verifySpineSkeleton(modern, names);
    expect(v.unmatched.map((u) => u.region)).toContain('items/sword');
    expect(v.verified).toBe(5);
  });
});

describe('scanSkeleton — legacy skins object', () => {
  // Legacy (≤3.7): skins is an OBJECT { skinName: { slot: { att: {...} } } }.
  const legacy = {
    skeleton: { spine: '3.7' },
    bones: [{ name: 'root' }],
    slots: [{ name: 'body' }],
    skins: {
      default: {
        body: { torso: { type: 'region' } },
        gear: { axe: { type: 'region', path: 'items/axe' } },
        point: { aim: { type: 'point' } }, // ignored
      },
    },
  };

  it('resolves the legacy object shape (recognized, not unverified)', () => {
    const scan = scanSkeleton(legacy);
    expect(scan.unverified).toBe(false);
    expect(scan.required.map((r) => r.region).sort()).toEqual(['items/axe', 'torso']);
  });

  it('verifies against packed names', () => {
    const v = verifySpineSkeleton(legacy, new Set(['torso', 'items/axe']));
    expect(v.verified).toBe(2);
    expect(v.unmatched).toEqual([]);
  });
});

describe('scanSkeleton — honest unverified (never a false 0-of-0)', () => {
  it('null (a .skel binary the worker hands as null) → unverified', () => {
    const v = verifySpineSkeleton(null, new Set(['x']));
    expect(v.unverified).toBe(true);
    expect(v.verified).toBe(0);
    expect(v.unmatched).toEqual([]);
  });

  it('an object with NO skins field → unverified (not a hollow 0-of-0)', () => {
    expect(scanSkeleton({ skeleton: {}, bones: [] }).unverified).toBe(true);
  });

  it('an unrecognized skins shape (number) → unverified', () => {
    expect(scanSkeleton({ skins: 42 }).unverified).toBe(true);
  });

  it('boundingbox and path attachment types are ignored', () => {
    const scan = scanSkeleton({
      skins: [{ name: 'default', attachments: { a: { bbox: { type: 'boundingbox' }, p: { type: 'path' } } } }],
    });
    expect(scan.unverified).toBe(false);
    expect(scan.required).toEqual([]);
  });

  it('absent type defaults to region (Spine convention)', () => {
    const scan = scanSkeleton({ skins: [{ name: 'default', attachments: { slot: { coin: {} } } }] });
    expect(scan.required.map((r) => r.region)).toEqual(['coin']);
  });
});
