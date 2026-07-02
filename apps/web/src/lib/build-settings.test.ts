// Pure-unit lock for the unified BuildSettings object + the EXTRACTED buildOptions body (settings-page
// design §3/§8-B1). apps/web has NO React harness (vitest env=node), so the load-bearing guarantees are
// pinned here:
//   1. BYTE-IDENTITY (B1): buildFixOptions(settingsDefaults(), <empty per-run>) equals the EXACT literal
//      option bag App.tsx's buildOptions() produced before the extraction — same worker input ⇒ same zip.
//   2. The mutual-exclusion matrix (profile ⇒ no scaleTiers / no webpNearLossless) decided against ONE
//      settings snapshot; frameRedundancy/trimMargin false-only-on-opt-out; spinePageFormat omitted on png.
//   3. patchSettings immutability + fresh-identity (the stale-plan reset effect keys on object identity).
//   4. scaleTiersOf ladder derivation (canonical high→low order, implied scale-1 top).

import { describe, it, expect } from 'vitest';
import type { OpKind } from './op-manifest';
import {
  buildFixOptions,
  patchSettings,
  scaleTiersOf,
  settingsDefaults,
  type BuildSettings,
  type PerRunOptions,
} from './build-settings';

/** The empty per-run inputs of a default run (no plan exclusions, no folder marking, no backend). */
function emptyRun(): PerRunOptions {
  return { excludeKinds: new Set<OpKind>(), marking: {}, skinGuard: {}, backend: undefined, backendWillUpload: false };
}

describe('settingsDefaults — reproduces today exactly, fresh objects', () => {
  it('two calls return equal but DISTINCT objects (no shared mutable state, incl. nested)', () => {
    const a = settingsDefaults();
    const b = settingsDefaults();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.profileFormats).not.toBe(b.profileFormats);
    expect(a.profileFormats['image/avif']).not.toBe(b.profileFormats['image/avif']);
    expect(a.tierSuffixes).not.toBe(b.tierSuffixes);
  });

  it('pins the legacy hardcodes + defaults surface (any change here is a deliberate behavior change)', () => {
    const s = settingsDefaults();
    expect(s.defaultTarget).toBe('image/avif'); // was hardcoded in buildOptions
    expect(s.defaultQuality).toBe(85); // wire /100 ⇒ 0.85
    expect(s.padding).toBe(2);
    expect(s.maxSize).toBe(4096);
    expect(s.maxEdge).toBe(2048);
    expect(s.pngRecompressLevel).toBe(0); // old boolean false
    expect(s.frameRedundancy).toBe(true); // default-ON pair
    expect(s.trimMargin).toBe(true);
    expect(s.spinePageFormat).toBe('png'); // NEW knob, default = today's PNG pages
    expect(s.tierSuffixes).toEqual(['_720p', '_540p']); // DEFAULT_SCALE_TIERS lower tiers, high→low
    expect(s.ktx2Enable).toBe(false);
    expect(s.pngquantEnable).toBe(false);
    expect(s.resampleEnable).toBe(false);
  });
});

describe('buildFixOptions — B1 byte-identity at defaults (the extracted buildOptions body)', () => {
  it('equals the EXACT literal bag the old App.tsx buildOptions() produced (every optional undefined)', () => {
    expect(buildFixOptions(settingsDefaults(), emptyRun())).toEqual({
      targetMime: 'image/avif',
      quality: 0.85,
      padding: 2,
      maxSize: 4096,
      maxEdge: 2048,
      aggressive: false,
      polygon: false,
      effort: undefined,
      scaleAwareQuality: undefined,
      webpNearLossless: undefined,
      pngRecompressLevel: undefined,
      opaqueAlpha: undefined,
      bestFormatPerImage: undefined,
      frameRedundancy: undefined,
      trimMargin: undefined,
      marking: undefined,
      skinGuard: undefined,
      overrides: undefined,
      packLoose: undefined,
      packMode: undefined,
      packGranularity: undefined,
      packTrim: undefined,
      scaleTiers: undefined,
      exportProfile: undefined,
      extrude: undefined,
      excludeKinds: undefined,
      emitPixiManifest: undefined,
      includeFileSizes: undefined,
      hashFilenames: undefined,
      spinePageFormat: undefined,
      backend: undefined,
    });
  });

  it('at defaults EVERY optional key is literally undefined (only the 7 required knobs carry values)', () => {
    const bag = buildFixOptions(settingsDefaults(), emptyRun());
    const defined = Object.entries(bag)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k)
      .sort();
    expect(defined).toEqual(['aggressive', 'maxEdge', 'maxSize', 'padding', 'polygon', 'quality', 'targetMime'].sort());
  });

  it('is deterministic: same settings + same run ⇒ deep-equal bags', () => {
    const s = patchSettings(settingsDefaults(), { profileEnable: true, effort: 3, tierEnable: true });
    expect(buildFixOptions(s, emptyRun())).toEqual(buildFixOptions(structuredClone(s), emptyRun()));
  });
});

describe('buildFixOptions — defaults section drives the profile-OFF loose path', () => {
  it('defaultTarget/defaultQuality replace the two hardcodes (webp q70 ⇒ targetMime webp, quality 0.7)', () => {
    const s = patchSettings(settingsDefaults(), { defaultTarget: 'image/webp', defaultQuality: 70 });
    const bag = buildFixOptions(s, emptyRun());
    expect(bag.targetMime).toBe('image/webp');
    expect(bag.quality).toBe(0.7);
  });

  it('padding/maxSize/maxEdge come from settings (no longer hardcoded)', () => {
    const s = patchSettings(settingsDefaults(), { padding: 4, maxSize: 2048, maxEdge: 1024 });
    const bag = buildFixOptions(s, emptyRun());
    expect(bag.padding).toBe(4);
    expect(bag.maxSize).toBe(2048);
    expect(bag.maxEdge).toBe(1024);
  });
});

describe('buildFixOptions — mutual exclusions decided against ONE settings snapshot', () => {
  it('profile ON (default AVIF format) ⇒ exportProfile sent, webpNearLossless + scaleTiers OMITTED', () => {
    const s = patchSettings(settingsDefaults(), {
      profileEnable: true,
      webpNearLossless: true,
      tierEnable: true, // both lower tiers on by default ⇒ ladder length 3 — still omitted under a profile
    });
    const bag = buildFixOptions(s, emptyRun());
    expect(bag.exportProfile).toBeDefined();
    expect(bag.webpNearLossless).toBeUndefined();
    expect(bag.scaleTiers).toBeUndefined();
  });

  it('profile OFF ⇒ webpNearLossless maps to the legacy 60; scaleTiers = the validated ladder', () => {
    const s = patchSettings(settingsDefaults(), { webpNearLossless: true, tierEnable: true });
    const bag = buildFixOptions(s, emptyRun());
    expect(bag.exportProfile).toBeUndefined();
    expect(bag.webpNearLossless).toBe(60);
    expect(bag.scaleTiers).toEqual([
      { scale: 1, suffix: '_1080p' },
      { scale: 0.75, suffix: '_720p' },
      { scale: 0.5, suffix: '_540p' },
    ]);
  });

  it('profile enabled but NO format selected ⇒ exportProfile undefined ⇒ the legacy knobs stay live', () => {
    const d = settingsDefaults();
    const s = patchSettings(d, {
      profileEnable: true,
      profileFormats: {
        ...d.profileFormats,
        'image/avif': { ...d.profileFormats['image/avif'], enabled: false },
      },
      webpNearLossless: true,
    });
    const bag = buildFixOptions(s, emptyRun());
    expect(bag.exportProfile).toBeUndefined();
    expect(bag.webpNearLossless).toBe(60);
  });

  it('tierEnable with NO lower tier opted in ⇒ scaleTiers omitted (top-alone would just rename)', () => {
    const s = patchSettings(settingsDefaults(), { tierEnable: true, tierSuffixes: [] });
    expect(buildFixOptions(s, emptyRun()).scaleTiers).toBeUndefined();
  });
});

describe('buildFixOptions — default-omission / opt-out wire contracts', () => {
  it('frameRedundancy/trimMargin: default ON ⇒ undefined; explicit opt-out ⇒ false (never true on the wire)', () => {
    const on = buildFixOptions(settingsDefaults(), emptyRun());
    expect(on.frameRedundancy).toBeUndefined();
    expect(on.trimMargin).toBeUndefined();
    const off = buildFixOptions(patchSettings(settingsDefaults(), { frameRedundancy: false, trimMargin: false }), emptyRun());
    expect(off.frameRedundancy).toBe(false);
    expect(off.trimMargin).toBe(false);
  });

  it('pngRecompressLevel: 0 ⇒ undefined; level N>0 ⇒ N verbatim (migrated old boolean true ≙ 2)', () => {
    expect(buildFixOptions(settingsDefaults(), emptyRun()).pngRecompressLevel).toBeUndefined();
    expect(buildFixOptions(patchSettings(settingsDefaults(), { pngRecompressLevel: 2 }), emptyRun()).pngRecompressLevel).toBe(2);
    expect(buildFixOptions(patchSettings(settingsDefaults(), { pngRecompressLevel: 5 }), emptyRun()).pngRecompressLevel).toBe(5);
  });

  it("spinePageFormat: 'png' (default) ⇒ wire field OMITTED (byte-identical); 'profile' ⇒ sent", () => {
    expect(buildFixOptions(settingsDefaults(), emptyRun()).spinePageFormat).toBeUndefined();
    expect(
      buildFixOptions(patchSettings(settingsDefaults(), { spinePageFormat: 'profile' }), emptyRun()).spinePageFormat,
    ).toBe('profile');
  });

  it('packLoose off ⇒ ALL pack knobs omitted; on ⇒ mode/granularity/trim forwarded', () => {
    const off = buildFixOptions(patchSettings(settingsDefaults(), { packMode: 'force-spine' }), emptyRun());
    expect(off.packLoose).toBeUndefined();
    expect(off.packMode).toBeUndefined();
    expect(off.packGranularity).toBeUndefined();
    expect(off.packTrim).toBeUndefined();
    const on = buildFixOptions(
      patchSettings(settingsDefaults(), { packLoose: true, packMode: 'force-static', packGranularity: 'one-sheet-for-all', packTrim: false }),
      emptyRun(),
    );
    expect(on.packLoose).toBe(true);
    expect(on.packMode).toBe('force-static');
    expect(on.packGranularity).toBe('one-sheet-for-all');
    expect(on.packTrim).toBe(false);
  });

  it('extrude: 0 ⇒ undefined; 2 ⇒ 2. effort: 0 ⇒ undefined; 4 ⇒ 4', () => {
    const bag = buildFixOptions(patchSettings(settingsDefaults(), { extrude: 2, effort: 4 }), emptyRun());
    expect(bag.extrude).toBe(2);
    expect(bag.effort).toBe(4);
  });

  it('legacy overrides: [] ⇒ undefined; blank-match rows filtered out of the wire', () => {
    expect(buildFixOptions(settingsDefaults(), emptyRun()).overrides).toBeUndefined();
    const s = patchSettings(settingsDefaults(), {
      overrides: [
        { match: 'ui/', quality: 0.8 },
        { match: '   ', quality: 0.5 },
      ],
    });
    expect(buildFixOptions(s, emptyRun()).overrides).toEqual([{ match: 'ui/', quality: 0.8 }]);
  });
});

describe('buildFixOptions — per-run inputs (FixCard-owned state)', () => {
  it('marking/skinGuard ride ONLY under aggressive AND non-empty (the gate lives here now)', () => {
    const run: PerRunOptions = { ...emptyRun(), marking: { hud: 'lazy' }, skinGuard: { key: 'value' } };
    const off = buildFixOptions(settingsDefaults(), run);
    expect(off.marking).toBeUndefined(); // aggressive false ⇒ gated off
    expect(off.skinGuard).toBeUndefined();
    const on = buildFixOptions(patchSettings(settingsDefaults(), { aggressive: true }), run);
    expect(on.marking).toEqual({ hud: 'lazy' });
    expect(on.skinGuard).toEqual({ key: 'value' });
    const empty = buildFixOptions(patchSettings(settingsDefaults(), { aggressive: true }), emptyRun());
    expect(empty.marking).toBeUndefined(); // empty objects never forwarded
    expect(empty.skinGuard).toBeUndefined();
  });

  it('excludeKinds: empty set ⇒ undefined; non-empty ⇒ the array (verbatim mask)', () => {
    const run: PerRunOptions = { ...emptyRun(), excludeKinds: new Set<OpKind>(['tier', 'repack']) };
    const bag = buildFixOptions(settingsDefaults(), run);
    expect(new Set(bag.excludeKinds)).toEqual(new Set(['tier', 'repack']));
  });

  it('backend is passed through VERBATIM (FixCard owns every consent-gated precondition)', () => {
    const backend = { apiBase: 'https://x.example', token: 't', ops: ['ktx2' as const], consent: true as const };
    const bag = buildFixOptions(settingsDefaults(), { ...emptyRun(), backend });
    expect(bag.backend).toBe(backend);
  });

  it('round12 auto-pair: backendWillUpload forces the Pixi manifest even when the toggle is off', () => {
    const run: PerRunOptions = { ...emptyRun(), backendWillUpload: true };
    const bag = buildFixOptions(settingsDefaults(), run);
    expect(bag.emitPixiManifest).toBe(true);
  });

  it('includeFileSizes: only with an emitted manifest AND a real mode', () => {
    // mode chosen but no manifest ⇒ omitted
    const noManifest = buildFixOptions(patchSettings(settingsDefaults(), { includeFileSizes: 'raw' }), emptyRun());
    expect(noManifest.includeFileSizes).toBeUndefined();
    // manifest on + 'gzip' ⇒ forwarded verbatim
    const on = buildFixOptions(
      patchSettings(settingsDefaults(), { emitPixiManifest: true, includeFileSizes: 'gzip' }),
      emptyRun(),
    );
    expect(on.emitPixiManifest).toBe(true);
    expect(on.includeFileSizes).toBe('gzip');
    // manifest on + 'off' ⇒ omitted
    const off = buildFixOptions(patchSettings(settingsDefaults(), { emitPixiManifest: true }), emptyRun());
    expect(off.includeFileSizes).toBeUndefined();
  });
});

describe('buildFixOptions — profile-ON carries the folded globals (single mapping, no drift)', () => {
  it('exportProfile folds effort/scaleAwareQ/pngRecompressLevel/avifSubsample at their legacy predicates', () => {
    const s = patchSettings(settingsDefaults(), {
      profileEnable: true,
      effort: 4,
      scaleAwareQ: true,
      pngRecompressLevel: 3,
      profileAvifSubsample: 3,
    });
    const bag = buildFixOptions(s, emptyRun());
    expect(bag.exportProfile).toEqual({
      formats: [{ format: 'image/avif', quality: 85 }],
      tiers: [{ label: '1080p (full)', scale: 1, suffix: '_1080p' }],
      effort: 4,
      scaleAwareQuality: true,
      pngRecompressLevel: 3,
      avifSubsample: 3,
    });
    // the standalone twins still ride for the non-profile paths, exactly like today
    expect(bag.effort).toBe(4);
    expect(bag.scaleAwareQuality).toBe(true);
    expect(bag.pngRecompressLevel).toBe(3);
  });
});

describe('patchSettings — immutable, always a fresh identity (stale-plan reset keys on it)', () => {
  it('returns a NEW object with the patch applied; the source is untouched', () => {
    const s = settingsDefaults();
    const p = patchSettings(s, { padding: 8, aggressive: true });
    expect(p).not.toBe(s);
    expect(p.padding).toBe(8);
    expect(p.aggressive).toBe(true);
    expect(s.padding).toBe(2); // source unchanged
    expect(s.aggressive).toBe(false);
  });

  it('an EMPTY patch still returns a fresh identity (every edit invalidates a pending plan)', () => {
    const s = settingsDefaults();
    const p = patchSettings(s, {});
    expect(p).not.toBe(s);
    expect(p).toEqual(s);
  });
});

describe('scaleTiersOf — the validated ladder derivation (ports the App memo)', () => {
  it('disabled ⇒ [] (no tiering)', () => {
    expect(scaleTiersOf(settingsDefaults())).toEqual([]);
  });

  it('enabled with the default suffixes ⇒ full canonical high→low ladder incl. the implied scale-1 top', () => {
    expect(scaleTiersOf(patchSettings(settingsDefaults(), { tierEnable: true }))).toEqual([
      { scale: 1, suffix: '_1080p' },
      { scale: 0.75, suffix: '_720p' },
      { scale: 0.5, suffix: '_540p' },
    ]);
  });

  it('a single opted-in lower tier keeps the top + that tier, order preserved', () => {
    const s = patchSettings(settingsDefaults(), { tierEnable: true, tierSuffixes: ['_540p'] });
    expect(scaleTiersOf(s)).toEqual([
      { scale: 1, suffix: '_1080p' },
      { scale: 0.5, suffix: '_540p' },
    ]);
  });

  it('enabled with NO lower tier ⇒ just the implied top (buildFixOptions then omits the ladder)', () => {
    const s = patchSettings(settingsDefaults(), { tierEnable: true, tierSuffixes: [] });
    expect(scaleTiersOf(s)).toEqual([{ scale: 1, suffix: '_1080p' }]);
  });
});

// Type-level regression: BuildSettings stays JSON-serializable-friendly for the config file (arrays, not
// Sets). A Set here would break serialize determinism silently — pin the runtime shape.
it('tierSuffixes is a plain array (JSON-serializable), never a Set', () => {
  const s: BuildSettings = settingsDefaults();
  expect(Array.isArray(s.tierSuffixes)).toBe(true);
});
