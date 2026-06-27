// Golden owner-selection + partition tests for buildDedupGroups (design §10.1–10.6). Pure & in-Node:
// we feed the function only the refs/hashes/flags the worker computes (no DOM, no canvas). The
// raw-multifolder-dupes fixture supplies the real cross-folder byte dupes; its expected.json is the
// authored golden. Determinism + shuffle-invariance + codepoint-cmp (NOT localeCompare) are asserted
// directly. Owners are NEVER drop targets; every consumer→owner edge satisfies the dominance rule.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import type { DedupGroup, ImageFeatures, LazyMarking, SkinGuard } from '@asset-doctor/core';
import { buildDedupGroups, cmp, bundleOf, baseNoExt, skinGroupOf, dominates } from '../src/index';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/sample-projects/raw-multifolder-dupes');

// ── fixture loader ────────────────────────────────────────────────────────────────────────────────
// Mirror the worker's keying exactly: each image's dir-aware ref is its POSIX folder-relative path, and
// its contentHash is the hex SHA-256 of the raw bytes (worker sha256Hex == node crypto sha256 hex).
// spineRefs = the dir-aware ref of any image paired with a sibling .atlas (the worker classifies these
// as kind:'spine'; here we detect the sidecar directly so the test stays pure).
interface Fixture {
  features: ImageFeatures[];
  spineRefs: Set<string>;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function loadFixture(): Fixture {
  const all = walk(FIXTURE);
  const features: ImageFeatures[] = [];
  const spineRefs = new Set<string>();
  const refOf = (abs: string): string => relative(FIXTURE, abs).split('\\').join('/');
  const present = new Set(all.map(refOf));
  for (const abs of all) {
    const ref = refOf(abs);
    if (!ref.endsWith('.png')) continue;
    const contentHash = createHash('sha256').update(readFileSync(abs)).digest('hex');
    features.push({ assetRef: ref, contentHash });
    // a .png with a sibling .atlas of the same basename ⇒ spine pool (worker kind:'spine').
    const atlasSibling = ref.replace(/\.png$/, '.atlas');
    if (present.has(atlasSibling)) spineRefs.add(ref);
  }
  // deterministic feature order so any input-order dependence is exercised by the shuffle test below.
  features.sort((a, b) => cmp(a.assetRef, b.assetRef));
  return { features, spineRefs };
}

// the golden marking + skin guard authored in the fixture's expected.json.
const MARKING: LazyMarking = { main_game: 'eager', fs_game: 'eager', bonus: 'lazy', bonus_b: 'lazy' };
const SKIN: SkinGuard = { skin_red: 'skin_blue' };

const groupByCase = (groups: DedupGroup[], owners: string[]): DedupGroup | undefined =>
  groups.find((g) => g.owners.length === owners.length && owners.every((o, i) => g.owners[i] === o));
const findGroup = (groups: DedupGroup[], anyOwner: string): DedupGroup | undefined =>
  groups.find((g) => g.owners.includes(anyOwner) || g.consumers.some((c) => c.ownerRef === anyOwner));
const consumerOf = (groups: DedupGroup[], ref: string) =>
  groups.flatMap((g) => g.consumers).find((c) => c.ref === ref);

// every retained owner must never appear as a consumer ref anywhere (owners are NEVER drop targets);
// every consumer→owner edge must satisfy the dominance rule and point at a same-(pool,skinGroup) owner.
function assertSafetyInvariants(groups: DedupGroup[], marking: LazyMarking, skin: SkinGuard): void {
  const allConsumerRefs = new Set(groups.flatMap((g) => g.consumers.map((c) => c.ref)));
  const availOf = (ref: string) => marking[bundleOf(ref)] ?? 'isolated';
  for (const g of groups) {
    for (const owner of g.owners) {
      expect(allConsumerRefs.has(owner)).toBe(false); // owner is never a drop target
      expect(skinGroupOf(owner, skin)).toBe(g.skinGroup);
    }
    for (const c of g.consumers) {
      expect(g.owners).toContain(c.ownerRef); // every consumer's owner is a retained owner of its group
      expect(skinGroupOf(c.ref, skin)).toBe(g.skinGroup); // same skin partition
      // dominance: same bundle OR eager owner. availability is keyed on the OWNER's bundle.
      expect(dominates(bundleOf(c.ownerRef), availOf(c.ownerRef), bundleOf(c.ref))).toBe(true);
    }
  }
}

describe('buildDedupGroups — golden owner-selection (§10.1)', () => {
  const { features, spineRefs } = loadFixture();
  const groups = buildDedupGroups(features, spineRefs, MARKING, SKIN);

  it('(a) cross-bundle eager pair → cmp-first eager owner, the other consumes eager-owner-cross-bundle', () => {
    // fs_game < main_game ⇒ owner is fs_game/logo.png; main_game/logo.png consumes.
    const g = findGroup(groups, 'fs_game/logo.png');
    expect(g?.owners).toEqual(['fs_game/logo.png']);
    expect(g?.consumers).toEqual([
      { ref: 'main_game/logo.png', ownerRef: 'fs_game/logo.png', reason: 'eager-owner-cross-bundle' },
    ]);
  });

  it('(b) same eager bundle → cmp-first owner, the other consumes same-eager-bundle', () => {
    // general < ui ⇒ owner main_game/general/icon.png; main_game/ui/icon.png consumes.
    const g = findGroup(groups, 'main_game/general/icon.png');
    expect(g?.owners).toEqual(['main_game/general/icon.png']);
    expect(g?.consumers).toEqual([
      { ref: 'main_game/ui/icon.png', ownerRef: 'main_game/general/icon.png', reason: 'same-eager-bundle' },
    ]);
  });

  it('(c) cross-bundle eager consume: eager + two lazy → both lazy consume the eager owner', () => {
    const g = findGroup(groups, 'main_game/spark.png');
    expect(g?.owners).toEqual(['main_game/spark.png']);
    expect(g?.consumers).toEqual([
      { ref: 'bonus/spark.png', ownerRef: 'main_game/spark.png', reason: 'eager-owner-cross-bundle' },
      { ref: 'bonus_b/spark.png', ownerRef: 'main_game/spark.png', reason: 'eager-owner-cross-bundle' },
    ]);
  });

  it('(h) atlas pair identical to an eager owner → repointable image consumer (eager-owner-cross-bundle)', () => {
    const g = findGroup(groups, 'main_game/sheet.png');
    expect(g?.owners).toEqual(['main_game/sheet.png']);
    expect(g?.consumers).toEqual([
      { ref: 'extra/sheet.png', ownerRef: 'main_game/sheet.png', reason: 'eager-owner-cross-bundle' },
    ]);
  });

  it('every consumer→owner edge is safe and owners are never drop targets', () => {
    assertSafetyInvariants(groups, MARKING, SKIN);
  });
});

describe('buildDedupGroups — pool separation (§10.2)', () => {
  const { features, spineRefs } = loadFixture();
  const groups = buildDedupGroups(features, spineRefs, MARKING, SKIN);

  it('a pixi sprite byte-identical to a spine frame never collapses across pools', () => {
    // props/frame.png (pixi) shares bytes with animations/{a,b}/frame.png (spine) but lives in the
    // pixi pool alone for that hash ⇒ no group references it at all.
    expect(consumerOf(groups, 'props/frame.png')).toBeUndefined();
    expect(groups.some((g) => g.owners.includes('props/frame.png'))).toBe(false);
    // the spine frames form their own spine-pool group.
    const spine = findGroup(groups, 'animations/a/frame.png');
    expect(spine?.pool).toBe('spine');
    expect(spine?.owners).toEqual(['animations/a/frame.png']);
    expect(spine?.consumers).toEqual([
      { ref: 'animations/b/frame.png', ownerRef: 'animations/a/frame.png', reason: 'same-isolated-bundle' },
    ]);
  });

  it('a spine owner only serves spine consumers (every owner/consumer shares its group pool)', () => {
    for (const g of groups) {
      const spineRefs2 = spineRefs;
      const poolOf = (r: string) => (spineRefs2.has(r) ? 'spine' : 'pixi');
      for (const o of g.owners) expect(poolOf(o)).toBe(g.pool);
      for (const c of g.consumers) expect(poolOf(c.ref)).toBe(g.pool);
    }
  });
});

describe('buildDedupGroups — skin guard + file-vs-folder basename (§10.3)', () => {
  const { features, spineRefs } = loadFixture();
  const groups = buildDedupGroups(features, spineRefs, MARKING, SKIN);

  it('(d) byte-identical keys/values skin pair must NOT collapse (different skinGroup partitions)', () => {
    // theme_default/skin_red.png (file basename skin_red ∈ keys) vs theme_dark/skin_blue.png
    // (file basename skin_blue ∈ values): different partitions, never a consumer/owner edge between them.
    expect(skinGroupOf('theme_default/skin_red.png', SKIN)).toBe('keys');
    expect(skinGroupOf('theme_dark/skin_blue.png', SKIN)).toBe('values');
    const c1 = consumerOf(groups, 'theme_default/skin_red.png');
    const c2 = consumerOf(groups, 'theme_dark/skin_blue.png');
    expect(c1).toBeUndefined();
    expect(c2).toBeUndefined();
    // neither sits in a group whose owners include the other.
    for (const g of groups) {
      const refs = [...g.owners, ...g.consumers.map((c) => c.ref)];
      expect(refs.includes('theme_default/skin_red.png') && refs.includes('theme_dark/skin_blue.png')).toBe(false);
    }
  });

  it('(e) matches the FILE basename, not the folder: skin_red/tile.png vs skin_blue/tile.png both general', () => {
    // The FOLDERS look like a skin key/value pair, but the file basename `tile` is in neither keys nor
    // values ⇒ both are `general`. This pins AD's deliberate file-basename rule (vs builder folder-basename).
    expect(skinGroupOf('skin_red/tile.png', SKIN)).toBe('general');
    expect(skinGroupOf('skin_blue/tile.png', SKIN)).toBe('general');
    // distinct isolated bundles, no eager peer ⇒ each its own owner, zero consumers.
    const g = groupByCase(groups, ['skin_blue/tile.png', 'skin_red/tile.png']);
    expect(g?.skinGroup).toBe('general');
    expect(g?.consumers).toEqual([]);
  });
});

describe('buildDedupGroups — determinism, shuffle-invariance, non-ASCII cmp (§10.4)', () => {
  it('is deterministic: two runs are deep-equal', () => {
    const { features, spineRefs } = loadFixture();
    const a = buildDedupGroups(features, spineRefs, MARKING, SKIN);
    const b = buildDedupGroups(features, spineRefs, MARKING, SKIN);
    expect(a).toEqual(b);
  });

  it('is shuffle-invariant: reversed input order yields identical output', () => {
    const { features, spineRefs } = loadFixture();
    const a = buildDedupGroups(features, spineRefs, MARKING, SKIN);
    const reversed = buildDedupGroups([...features].reverse(), spineRefs, MARKING, SKIN);
    expect(reversed).toEqual(a);
    // a different permutation (rotate) must also match.
    const rotated = buildDedupGroups([...features.slice(3), ...features.slice(0, 3)], spineRefs, MARKING, SKIN);
    expect(rotated).toEqual(a);
  });

  it('owners/consumers/groups are sorted by the codepoint cmp', () => {
    const { features, spineRefs } = loadFixture();
    const groups = buildDedupGroups(features, spineRefs, MARKING, SKIN);
    for (const g of groups) {
      expect(g.owners).toEqual([...g.owners].sort(cmp));
      expect(g.consumers.map((c) => c.ref)).toEqual([...g.consumers.map((c) => c.ref)].sort(cmp));
    }
    const keys = groups.map((g) => g.contentHash + ' ' + g.pool + ' ' + g.skinGroup);
    expect(keys).toEqual([...keys].sort(cmp));
  });

  it('cmp is codepoint order, NOT localeCompare (load-bearing for cross-runtime determinism)', () => {
    // localeCompare typically orders 'a' < 'B' (case-insensitive primary), whereas codepoint puts all
    // uppercase before lowercase: 'B'(66) < 'a'(97). cmp must follow codepoints.
    expect(cmp('B', 'a')).toBe(-1);
    expect('B'.localeCompare('a')).toBeGreaterThan(0); // proves the two disagree here
    // non-ASCII: 'Z'(90) < 'é'(233) < 'à'(224)? codepoint: à(224) < é(233). localeCompare may differ.
    expect(cmp('Z', 'é')).toBe(-1);
    expect(cmp('à', 'é')).toBe(-1);
    expect(cmp('é', 'à')).toBe(1);
    // owner tie-break uses cmp: a non-ASCII pair resolves by codepoint deterministically.
    const features: ImageFeatures[] = [
      { assetRef: 'pkg/é.png', contentHash: 'h' },
      { assetRef: 'pkg/à.png', contentHash: 'h' },
    ];
    const g = buildDedupGroups(features, new Set(), {}, {})[0];
    expect(g?.owners).toEqual(['pkg/à.png']); // à(224) < é(233) by codepoint
    expect(g?.consumers).toEqual([{ ref: 'pkg/é.png', ownerRef: 'pkg/à.png', reason: 'same-isolated-bundle' }]);
  });
});

describe('buildDedupGroups — isolated default (§10.5)', () => {
  it('unmarked same-basename cross-folder dupes never collapse (default isolated, zero cross edges)', () => {
    // two byte-identical files in different UNMARKED bundles ⇒ both isolated ⇒ each keeps its own owner.
    const features: ImageFeatures[] = [
      { assetRef: 'world_a/coin.png', contentHash: 'same' },
      { assetRef: 'world_b/coin.png', contentHash: 'same' },
    ];
    const groups = buildDedupGroups(features, new Set(), {} /* no marking */, {});
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g?.owners).toEqual(['world_a/coin.png', 'world_b/coin.png']); // both retained
    expect(g?.consumers).toEqual([]); // zero cross-bundle drops
  });

  it('isolated bundle still dedups WITHIN itself (same-isolated-bundle)', () => {
    const features: ImageFeatures[] = [
      { assetRef: 'world/a.png', contentHash: 'same' },
      { assetRef: 'world/b.png', contentHash: 'same' },
    ];
    const groups = buildDedupGroups(features, new Set(), {}, {});
    expect(groups[0]?.owners).toEqual(['world/a.png']);
    expect(groups[0]?.consumers).toEqual([
      { ref: 'world/b.png', ownerRef: 'world/a.png', reason: 'same-isolated-bundle' },
    ]);
  });
});

describe('buildDedupGroups — lazy-vs-lazy (§10.6)', () => {
  it('two lazy bundles, identical content, no eager peer → per-bundle owners, zero cross edges', () => {
    const features: ImageFeatures[] = [
      { assetRef: 'levelA/fx.png', contentHash: 'same' },
      { assetRef: 'levelB/fx.png', contentHash: 'same' },
    ];
    const marking: LazyMarking = { levelA: 'lazy', levelB: 'lazy' };
    const groups = buildDedupGroups(features, new Set(), marking, {});
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g?.owners).toEqual(['levelA/fx.png', 'levelB/fx.png']); // each lazy bundle keeps its own
    expect(g?.consumers).toEqual([]); // a lazy bundle never owns OR consumes across bundles
  });

  it('lazy bundle still dedups WITHIN itself (same-lazy-bundle), with no eager peer', () => {
    const features: ImageFeatures[] = [
      { assetRef: 'levelA/fx.png', contentHash: 'same' },
      { assetRef: 'levelA/fx_copy.png', contentHash: 'same' },
      { assetRef: 'levelB/fx.png', contentHash: 'same' },
    ];
    const marking: LazyMarking = { levelA: 'lazy', levelB: 'lazy' };
    const groups = buildDedupGroups(features, new Set(), marking, {});
    const g = groups[0];
    // levelA: cmp-first local owner fx.png, fx_copy.png consumes; levelB: standalone owner, no drop.
    expect(g?.owners).toEqual(['levelA/fx.png', 'levelB/fx.png']);
    expect(g?.consumers).toEqual([
      { ref: 'levelA/fx_copy.png', ownerRef: 'levelA/fx.png', reason: 'same-lazy-bundle' },
    ]);
  });

  it('eager + lazy never makes the eager member consume the lazy owner (eager always wins owner)', () => {
    // an eager member present ⇒ eager-anchored: the eager copy is the owner, the lazy copy consumes it;
    // the eager member is NEVER a consumer of a lazy owner.
    const features: ImageFeatures[] = [
      { assetRef: 'lazyZone/m.png', contentHash: 'same' },
      { assetRef: 'core/m.png', contentHash: 'same' },
    ];
    const groups = buildDedupGroups(features, new Set(), { core: 'eager', lazyZone: 'lazy' }, {});
    const g = groups[0];
    expect(g?.owners).toEqual(['core/m.png']);
    expect(g?.consumers).toEqual([
      { ref: 'lazyZone/m.png', ownerRef: 'core/m.png', reason: 'eager-owner-cross-bundle' },
    ]);
  });
});

describe('buildDedupGroups — helper exports', () => {
  it('bundleOf / baseNoExt behave on dir-aware refs and flat refs', () => {
    expect(bundleOf('main_game/ui/x.png')).toBe('main_game');
    expect(bundleOf('flat.png')).toBe('flat.png'); // no slash ⇒ its own singleton bundle
    expect(baseNoExt('a/b/icon.png')).toBe('icon');
    expect(baseNoExt('icon.PNG')).toBe('icon'); // case-insensitive extension strip
  });
});
