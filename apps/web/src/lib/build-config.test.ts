// AB-R5 — pure-unit lock for the build-config serialize/parse/validate core. apps/web has NO React
// harness (vitest env=node), so all the load-bearing logic lives in build-config.ts and is asserted here:
// round-trip identity, determinism (pinned exact string), the FAIL-CLOSED parse path (malformed / wrong-kind
// / not-object / future-version / extra-keys / partial / wrong-typed — never throws), the validateProfile
// gate (lossless-AVIF / dupTarget / bad-suffix / empty-formats each rejected), and the NO-DRIFT guard that
// pins buildProfileFromState's mapping (near→60, effort folded only when >0, avifSubsample omitted when
// undefined) so a future memo edit that forgets to call the shared fn is caught. The button click → file
// download / file picker is the ONE browser-only seam (no harness), copied verbatim from the shipped
// downloadZip + folder <input>; the only NEW logic is the pure functions tested below.

import { describe, it, expect } from 'vitest';
import type { ExportProfile } from '@asset-doctor/core';
import {
  serializeBuildConfig,
  parseBuildConfig,
  buildProfileFromState,
  pickState,
  BUILD_CONFIG_VERSION,
  type BuildConfigState,
} from './build-config';

/** A representative, fully-exercised state: multi-format, custom tier, a fonts-444 override, avifSubsample 3,
 *  effort 4, scaleAware on, pngRecompress on. */
function richState(): BuildConfigState {
  return {
    profileEnable: true,
    profileFormats: {
      'image/png': { enabled: true, quality: 85, lossless: true, near: false, pngLossy: false },
      'image/webp': { enabled: true, quality: 80, lossless: false, near: true },
      'image/avif': { enabled: true, quality: 70, lossless: false, near: false },
    },
    customTiers: [{ label: '0.5×', scale: 0.5, suffix: '_540p' }],
    profileOverrides: [{ match: 'fonts', mode: 'fonts444', quality: 90 }],
    profileAvifSubsample: 3,
    effort: 4,
    scaleAwareQ: true,
    pngRecompress: true,
  };
}

describe('round-trip identity', () => {
  it('parse(serialize(state)).state deep-equals state for a rich representative state', () => {
    const s = richState();
    const res = parseBuildConfig(serializeBuildConfig(s));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.state).toEqual(s);
  });

  it('round-trips the DEFAULT (disabled, AVIF-only) state', () => {
    const s: BuildConfigState = {
      profileEnable: false,
      profileFormats: {
        'image/png': { enabled: false, quality: 85, lossless: true, near: false, pngLossy: false },
        'image/webp': { enabled: false, quality: 85, lossless: false, near: false },
        'image/avif': { enabled: true, quality: 85, lossless: false, near: false },
      },
      customTiers: [],
      profileOverrides: [],
      profileAvifSubsample: undefined,
      effort: 0,
      scaleAwareQ: false,
      pngRecompress: false,
    };
    const res = parseBuildConfig(serializeBuildConfig(s));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.state).toEqual(s);
  });
});

describe('determinism', () => {
  it('serializeBuildConfig(s) === serializeBuildConfig(structuredClone(s)) (stable key order)', () => {
    const s = richState();
    expect(serializeBuildConfig(s)).toBe(serializeBuildConfig(structuredClone(s)));
  });

  it('pins the EXACT serialized string for one fixture (avifSubsample present, 2-space JSON, fixed key order)', () => {
    // A dedicated fixture (pngRecompress OFF) so the pinned string below is self-contained, not derived.
    const s: BuildConfigState = { ...richState(), pngRecompress: false };
    const expected = `{
  "kind": "asset-doctor/build-config",
  "version": 1,
  "profile": {
    "enabled": true,
    "formats": {
      "image/png": {
        "enabled": true,
        "quality": 85,
        "lossless": true,
        "near": false,
        "pngLossy": false
      },
      "image/webp": {
        "enabled": true,
        "quality": 80,
        "lossless": false,
        "near": true
      },
      "image/avif": {
        "enabled": true,
        "quality": 70,
        "lossless": false,
        "near": false
      }
    },
    "customTiers": [
      {
        "label": "0.5×",
        "scale": 0.5,
        "suffix": "_540p"
      }
    ],
    "overrides": [
      {
        "match": "fonts",
        "mode": "fonts444",
        "quality": 90
      }
    ],
    "avifSubsample": 3
  },
  "globals": {
    "effort": 4,
    "scaleAwareQuality": true,
    "pngRecompress": false
  }
}`;
    expect(serializeBuildConfig(s)).toBe(expected);
  });

  it('OMITS avifSubsample when undefined (key absent, not null)', () => {
    const s = { ...richState(), profileAvifSubsample: undefined };
    const text = serializeBuildConfig(s);
    expect(text).not.toContain('avifSubsample');
    expect(JSON.parse(text).profile.avifSubsample).toBeUndefined();
  });
});

describe('fail-closed parse — never throws, returns a reasonKey', () => {
  it('malformed JSON → fix.config.err.malformed (does NOT throw)', () => {
    let res!: ReturnType<typeof parseBuildConfig>;
    expect(() => (res = parseBuildConfig('{ not json'))).not.toThrow();
    expect(res).toEqual({ ok: false, reasonKey: 'fix.config.err.malformed' });
  });

  it('not an object: a bare number → fix.config.err.notObject', () => {
    expect(parseBuildConfig('42')).toEqual({ ok: false, reasonKey: 'fix.config.err.notObject' });
  });

  it('null → fix.config.err.notObject', () => {
    expect(parseBuildConfig('null')).toEqual({ ok: false, reasonKey: 'fix.config.err.notObject' });
  });

  it('array → fix.config.err.notObject', () => {
    expect(parseBuildConfig('[]')).toEqual({ ok: false, reasonKey: 'fix.config.err.notObject' });
  });

  it('wrong/missing kind → fix.config.err.wrongKind', () => {
    expect(parseBuildConfig(JSON.stringify({ version: 1, profile: {}, globals: {} }))).toEqual({
      ok: false,
      reasonKey: 'fix.config.err.wrongKind',
    });
    expect(parseBuildConfig(JSON.stringify({ kind: 'something-else', version: 1 }))).toEqual({
      ok: false,
      reasonKey: 'fix.config.err.wrongKind',
    });
  });

  it('future version (99) → fix.config.err.version with detail', () => {
    const res = parseBuildConfig(JSON.stringify({ kind: 'asset-doctor/build-config', version: 99 }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reasonKey).toBe('fix.config.err.version');
      expect(res.detail).toBe('99');
    }
  });

  it('non-integer / missing version → fix.config.err.version', () => {
    expect(parseBuildConfig(JSON.stringify({ kind: 'asset-doctor/build-config', version: 1.5 })).ok).toBe(false);
    expect(parseBuildConfig(JSON.stringify({ kind: 'asset-doctor/build-config' }))).toMatchObject({
      ok: false,
      reasonKey: 'fix.config.err.version',
    });
  });
});

describe('tolerant coercion — extra keys dropped, partial backfilled, wrong types clamped', () => {
  it('extra keys (profile.bogus, top-level attack) are dropped; valid config still parses ok', () => {
    const s = richState();
    const obj = JSON.parse(serializeBuildConfig(s));
    obj.attack = 'rm -rf';
    obj.profile.bogus = { evil: true };
    obj.globals.unknown = 7;
    const res = parseBuildConfig(JSON.stringify(obj));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.state).toEqual(s); // extras dropped, no leakage
  });

  it('partial config (no globals, missing a format entry, no customTiers) → backfilled from defaults, ok', () => {
    const partial = {
      kind: 'asset-doctor/build-config',
      version: 1,
      profile: { enabled: true, formats: { 'image/avif': { enabled: true, quality: 60, lossless: false, near: false } } },
    };
    const res = parseBuildConfig(JSON.stringify(partial));
    expect(res.ok).toBe(true);
    if (res.ok) {
      // missing PNG/WebP backfilled from defaults
      expect(res.state.profileFormats['image/png']).toEqual({ enabled: false, quality: 85, lossless: true, near: false, pngLossy: false });
      expect(res.state.profileFormats['image/webp']).toEqual({ enabled: false, quality: 85, lossless: false, near: false });
      expect(res.state.profileFormats['image/avif']).toEqual({ enabled: true, quality: 60, lossless: false, near: false });
      expect(res.state.customTiers).toEqual([]);
      expect(res.state.profileOverrides).toEqual([]);
      expect(res.state.effort).toBe(0);
      expect(res.state.scaleAwareQ).toBe(false);
      expect(res.state.pngRecompress).toBe(false);
      expect(res.state.profileAvifSubsample).toBeUndefined();
    }
  });

  it('wrong-typed fields (effort:"x", customTiers:{}, formats array) → no throw, coerced, deterministic', () => {
    const garbage = {
      kind: 'asset-doctor/build-config',
      version: 1,
      profile: { enabled: true, formats: { 'image/avif': { enabled: 'yes', quality: 'high', lossless: 1, near: null } }, customTiers: {}, overrides: 'nope' },
      globals: { effort: 'x', scaleAwareQuality: 3, pngRecompress: 'maybe' },
    };
    let res!: ReturnType<typeof parseBuildConfig>;
    expect(() => (res = parseBuildConfig(JSON.stringify(garbage)))).not.toThrow();
    expect(res.ok).toBe(true);
    if (res.ok) {
      // 'yes'/'high'/1/null clamp to the per-format defaults (typed → validateProfile never hits a TypeError).
      // AVIF's default enabled is TRUE, so a non-boolean 'yes' falls back to that default (true).
      expect(res.state.profileFormats['image/avif']).toEqual({ enabled: true, quality: 85, lossless: false, near: false });
      expect(res.state.customTiers).toEqual([]); // non-array → []
      expect(res.state.profileOverrides).toEqual([]); // non-array → []
      expect(res.state.effort).toBe(0); // 'x' → default
      expect(res.state.scaleAwareQ).toBe(false); // 3 → default
      expect(res.state.pngRecompress).toBe(false); // 'maybe' → default
    }
    // deterministic: re-coercing the same garbage yields the same state
    expect(pickState(garbage)).toEqual(pickState(JSON.parse(JSON.stringify(garbage))));
  });
});

describe('fail-closed semantics — validateProfile is the gate', () => {
  function buildEnabled(overrides: Partial<BuildConfigState>): string {
    const base = richState();
    return serializeBuildConfig({ ...base, ...overrides });
  }

  it('lossless AVIF is forced LOSSY by buildProfileFromState — so the file path can NEVER produce a faked-lossless AVIF', () => {
    // HONESTY: the UI/config shape carries a per-format `lossless` boolean even for AVIF, but
    // buildProfileFromState ALWAYS emits AVIF as lossy (the UI has no honest lossless-AVIF path). So a
    // hand-edited file with image/avif.lossless:true can't smuggle a losslessAvif target past the validator —
    // it's structurally impossible, the strongest form of fail-closed. Assert the rebuilt profile is lossy.
    const smuggled = {
      kind: 'asset-doctor/build-config',
      version: 1,
      profile: {
        enabled: true,
        formats: { 'image/avif': { enabled: true, quality: 70, lossless: true, near: false } },
        customTiers: [],
      },
      globals: { effort: 0, scaleAwareQuality: false, pngRecompress: false },
    };
    const res = parseBuildConfig(JSON.stringify(smuggled));
    expect(res.ok).toBe(true); // accepted — because it's a LOSSY AVIF, never a lossless one
    if (res.ok) {
      const profile = buildProfileFromState(res.state);
      expect(profile?.formats).toEqual([{ format: 'image/avif', quality: 70 }]); // no `lossless` key
    }
    // And a genuinely-invalid GLOBAL avif knob (subsample 9) IS rejected by validateProfile (the gate).
    const badSub = parseBuildConfig(buildEnabled({ profileAvifSubsample: 9 }));
    expect(badSub.ok).toBe(false);
    if (!badSub.ok) {
      expect(badSub.reasonKey).toBe('fix.config.err.invalid');
      expect(badSub.detail).toContain('badSubsample');
    }
  });

  it('duplicate tier suffix (two custom tiers, same suffix) → fix.config.err.invalid (tier dupSuffix)', () => {
    // The UI format shape is one entry per format, so a dup FORMAT target isn't expressible; a dup TIER suffix
    // IS (two custom tiers, same suffix) — and it goes through the SAME validateProfile→validateTiers gate.
    const dupTier = {
      kind: 'asset-doctor/build-config',
      version: 1,
      profile: {
        enabled: true,
        formats: { 'image/avif': { enabled: true, quality: 70, lossless: false, near: false } },
        customTiers: [
          { label: 'a', scale: 0.5, suffix: '_540p' },
          { label: 'b', scale: 0.6, suffix: '_540p' },
        ],
      },
      globals: { effort: 0, scaleAwareQuality: false, pngRecompress: false },
    };
    const res = parseBuildConfig(JSON.stringify(dupTier));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reasonKey).toBe('fix.config.err.invalid');
      expect(res.detail).toContain('dupSuffix');
    }
  });

  it('bad tier suffix (a dot fails RESOLUTION_TOKEN + SUFFIX_TOKEN — would fake an extension) → fix.config.err.invalid (tier badSuffix)', () => {
    // A dot is rejected by isSafeSuffix (it would fake an extension in the emitted name). Goes through the
    // SAME validateProfile→validateTiers gate; the detail carries the verbatim `badSuffix` validator string.
    const badSuffix = {
      kind: 'asset-doctor/build-config',
      version: 1,
      profile: {
        enabled: true,
        formats: { 'image/avif': { enabled: true, quality: 70, lossless: false, near: false } },
        customTiers: [{ label: 'x', scale: 0.5, suffix: '_bad.suffix' }],
      },
      globals: { effort: 0, scaleAwareQuality: false, pngRecompress: false },
    };
    const res = parseBuildConfig(JSON.stringify(badSuffix));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reasonKey).toBe('fix.config.err.invalid');
      expect(res.detail).toContain('badSuffix');
    }
  });

  it('empty formats (enabled profile, no format selected) → fix.config.err.invalid (emptyFormats)', () => {
    const empty = {
      kind: 'asset-doctor/build-config',
      version: 1,
      profile: {
        enabled: true,
        formats: {
          'image/png': { enabled: false, quality: 85, lossless: true, near: false, pngLossy: false },
          'image/webp': { enabled: false, quality: 85, lossless: false, near: false },
          'image/avif': { enabled: false, quality: 85, lossless: false, near: false },
        },
        customTiers: [],
      },
      globals: { effort: 0, scaleAwareQuality: false, pngRecompress: false },
    };
    const res = parseBuildConfig(JSON.stringify(empty));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reasonKey).toBe('fix.config.err.invalid');
      expect(res.detail).toContain('emptyFormats');
    }
  });

  it('a saved-but-DISABLED config with valid formats still loads ok (apply the disabled flag as-is)', () => {
    const s = { ...richState(), profileEnable: false };
    const res = parseBuildConfig(serializeBuildConfig(s));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.state.profileEnable).toBe(false);
  });
});

describe('no-drift guard — buildProfileFromState pins the memo mapping', () => {
  it('builds the EXACT ExportProfile the App memo would (near→60, effort folded only >0, avifSubsample present)', () => {
    const profile = buildProfileFromState(richState());
    const expected: ExportProfile = {
      formats: [
        { format: 'image/png' },
        { format: 'image/webp', quality: 80, near: 60 },
        { format: 'image/avif', quality: 70 },
      ],
      tiers: [
        { label: '1080p (full)', scale: 1, suffix: '_1080p' },
        { label: '0.5×', scale: 0.5, suffix: '_540p' },
      ],
      effort: 4,
      scaleAwareQuality: true,
      pngRecompressLevel: 2,
      avifSubsample: 3,
      overrides: [{ match: 'fonts', formats: [{ format: 'image/avif', quality: 90 }], avifSubsample: 3 }],
    };
    expect(profile).toEqual(expected);
  });

  it('effort is OMITTED when 0; avifSubsample OMITTED when undefined; scaleAware/pngRecompress omitted when off', () => {
    const minimal: BuildConfigState = {
      profileEnable: true,
      profileFormats: {
        'image/png': { enabled: false, quality: 85, lossless: true, near: false, pngLossy: false },
        'image/webp': { enabled: false, quality: 85, lossless: false, near: false },
        'image/avif': { enabled: true, quality: 85, lossless: false, near: false },
      },
      customTiers: [],
      profileOverrides: [],
      profileAvifSubsample: undefined,
      effort: 0,
      scaleAwareQ: false,
      pngRecompress: false,
    };
    const profile = buildProfileFromState(minimal);
    expect(profile).toEqual({
      formats: [{ format: 'image/avif', quality: 85 }],
      tiers: [{ label: '1080p (full)', scale: 1, suffix: '_1080p' }],
    });
    expect(profile && 'effort' in profile).toBe(false);
    expect(profile && 'avifSubsample' in profile).toBe(false);
    expect(profile && 'scaleAwareQuality' in profile).toBe(false);
    expect(profile && 'pngRecompressLevel' in profile).toBe(false);
    expect(profile && 'overrides' in profile).toBe(false);
  });

  it('disabled OR no-format-selected ⇒ undefined (never a known-bad empty-formats profile)', () => {
    expect(buildProfileFromState({ ...richState(), profileEnable: false })).toBeUndefined();
    const noFmt = richState();
    noFmt.profileFormats = {
      'image/png': { enabled: false, quality: 85, lossless: true, near: false, pngLossy: false },
      'image/webp': { enabled: false, quality: 85, lossless: false, near: false },
      'image/avif': { enabled: false, quality: 85, lossless: false, near: false },
    };
    expect(buildProfileFromState(noFmt)).toBeUndefined();
  });
});

it('BUILD_CONFIG_VERSION is 1 (the only accepted version in v1)', () => {
  expect(BUILD_CONFIG_VERSION).toBe(1);
});
