// AB-R5 (v1) + settings-page design §6 (v2) — pure-unit lock for the build-config serialize/parse/
// validate core. apps/web has NO React harness (vitest env=node), so all the load-bearing logic lives in
// build-config.ts and is asserted here: full-surface v2 round-trip identity, determinism (pinned exact
// string), the v1→v2 MIGRATION (pngRecompress boolean → pngRecompressLevel; missing sections backfilled),
// the FAIL-CLOSED parse path (malformed / wrong-kind / not-object / future-version / extra-keys / partial /
// wrong-typed — never throws), the validateProfile gate (lossless-AVIF / dupSuffix / bad-suffix /
// empty-formats each rejected), the NEVER-SERIALIZED / NEVER-RESTORED pins for the backend-op toggles
// (consent is per-run — invariant), and the NO-DRIFT guard for buildProfileFromState (the single
// UI→ExportProfile mapping). The button click → file download / file picker is the ONE browser-only seam
// (no harness); the only NEW logic is the pure functions tested below.

import { describe, it, expect } from 'vitest';
import type { ExportProfile } from '@asset-doctor/core';
import { settingsDefaults, type BuildSettings } from './build-settings';
import {
  serializeBuildConfig,
  parseBuildConfig,
  buildProfileFromState,
  pickSettings,
  BUILD_CONFIG_VERSION,
  type BuildConfigState,
} from './build-config';

/** A representative, fully-exercised v2 state: every section off its default (multi-format profile,
 *  custom tier, a fonts-444 override, avifSubsample 3, non-default defaults/globals/rules/packing/
 *  resize/output). Backend-op toggles stay false — they are never serialized regardless. */
function richSettings(): BuildSettings {
  return {
    ...settingsDefaults(),
    profileEnable: true,
    profileFormats: {
      'image/png': { enabled: true, quality: 85, lossless: true, near: false, pngLossy: false },
      'image/webp': { enabled: true, quality: 80, lossless: false, near: true },
      'image/avif': { enabled: true, quality: 70, lossless: false, near: false },
    },
    customTiers: [{ label: '0.5×', scale: 0.5, suffix: '_540p' }],
    profileOverrides: [{ match: 'fonts', mode: 'fonts444', quality: 90 }],
    profileAvifSubsample: 3,
    defaultTarget: 'image/webp',
    defaultQuality: 75,
    effort: 4,
    scaleAwareQ: true,
    webpNearLossless: true,
    pngRecompressLevel: 2,
    aggressive: true,
    opaqueAlpha: true,
    bestFormatPerImage: true,
    frameRedundancy: false,
    trimMargin: false,
    overrides: [{ match: 'ui/', quality: 0.8 }],
    padding: 4,
    maxSize: 2048,
    extrude: 1,
    packLoose: true,
    packMode: 'force-static',
    packGranularity: 'one-sheet-for-all',
    packTrim: false,
    polygon: true,
    spinePageFormat: 'profile',
    maxEdge: 4096,
    tierEnable: true,
    tierSuffixes: ['_720p'],
    hashFilenames: true,
    emitPixiManifest: true,
    includeFileSizes: 'gzip',
  };
}

/** A minimal VALID v1 file (the pre-settings-page on-disk shape) for the migration tests. */
function v1File(pngRecompress: boolean): string {
  return JSON.stringify({
    kind: 'asset-doctor/build-config',
    version: 1,
    profile: {
      enabled: true,
      formats: {
        'image/png': { enabled: false, quality: 85, lossless: true, near: false, pngLossy: false },
        'image/webp': { enabled: false, quality: 85, lossless: false, near: false },
        'image/avif': { enabled: true, quality: 70, lossless: false, near: false },
      },
      customTiers: [{ label: '0.5×', scale: 0.5, suffix: '_540p' }],
      overrides: [],
    },
    globals: { effort: 3, scaleAwareQuality: true, pngRecompress },
  });
}

describe('round-trip identity (v2 full surface)', () => {
  it('parse(serialize(state)).state deep-equals state (+ the transitional pngRecompress view) for a rich state', () => {
    const s = richSettings();
    const res = parseBuildConfig(serializeBuildConfig(s));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.state).toEqual({ ...s, pngRecompress: true }); // level 2 ⇒ legacy view true
  });

  it('round-trips the DEFAULT state (profile off, AVIF-only, everything at settingsDefaults)', () => {
    const s = settingsDefaults();
    const res = parseBuildConfig(serializeBuildConfig(s));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.state).toEqual({ ...s, pngRecompress: false });
  });

  it('serialize(parse(v1File).state) produces a VALID v2 file (migration is re-serializable)', () => {
    const res = parseBuildConfig(v1File(true));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const reSerialized = serializeBuildConfig(res.state);
    expect(JSON.parse(reSerialized).version).toBe(2);
    const again = parseBuildConfig(reSerialized);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.state).toEqual(res.state);
  });
});

describe('determinism', () => {
  it('serializeBuildConfig(s) === serializeBuildConfig(structuredClone(s)) (stable key order)', () => {
    const s = richSettings();
    expect(serializeBuildConfig(s)).toBe(serializeBuildConfig(structuredClone(s)));
  });

  it('pins the EXACT serialized DEFAULTS string (v2 §6 key order, 2-space JSON, avifSubsample omitted)', () => {
    const expected = `{
  "kind": "asset-doctor/build-config",
  "version": 2,
  "profile": {
    "enabled": false,
    "formats": {
      "image/png": {
        "enabled": false,
        "quality": 85,
        "lossless": true,
        "near": false,
        "pngLossy": false
      },
      "image/webp": {
        "enabled": false,
        "quality": 85,
        "lossless": false,
        "near": false
      },
      "image/avif": {
        "enabled": true,
        "quality": 85,
        "lossless": false,
        "near": false
      }
    },
    "customTiers": [],
    "overrides": []
  },
  "defaults": {
    "target": "image/avif",
    "quality": 85
  },
  "globals": {
    "effort": 0,
    "scaleAwareQuality": false,
    "pngRecompressLevel": 0,
    "webpNearLossless": false
  },
  "rules": {
    "aggressive": false,
    "opaqueAlpha": false,
    "stripMetadata": false,
    "bestFormatPerImage": false,
    "frameRedundancy": true,
    "trimMargin": true,
    "overrides": []
  },
  "packing": {
    "padding": 2,
    "maxSize": 4096,
    "extrude": 0,
    "packLoose": false,
    "packMode": "auto",
    "packGranularity": "per-leaf-folder",
    "packTrim": true,
    "polygon": false,
    "spinePageFormat": "png"
  },
  "resize": {
    "maxEdge": 2048,
    "tierEnable": false,
    "tierSuffixes": [
      "_720p",
      "_540p"
    ]
  },
  "output": {
    "hashFilenames": false,
    "emitPixiManifest": false,
    "includeFileSizes": "off"
  }
}`;
    expect(serializeBuildConfig(settingsDefaults())).toBe(expected);
  });

  it('OMITS avifSubsample when undefined (key absent, not null)', () => {
    const s = { ...richSettings(), profileAvifSubsample: undefined };
    const text = serializeBuildConfig(s);
    expect(text).not.toContain('avifSubsample');
    expect(JSON.parse(text).profile.avifSubsample).toBeUndefined();
  });

  it('canonicalizes tierSuffixes to the preset high→low ladder order (a Set-backed UI has no order)', () => {
    const s = { ...richSettings(), tierSuffixes: ['_540p', '_720p'] }; // reversed on purpose
    expect(JSON.parse(serializeBuildConfig(s)).resize.tierSuffixes).toEqual(['_720p', '_540p']);
  });
});

describe('v1 → v2 migration (older version accepted + backfilled)', () => {
  it('pngRecompress:true ⇒ pngRecompressLevel 2 (the exact old wire value); profile+globals applied', () => {
    const res = parseBuildConfig(v1File(true));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state.pngRecompressLevel).toBe(2);
    expect(res.state.pngRecompress).toBe(true); // transitional legacy view
    expect(res.state.profileEnable).toBe(true);
    expect(res.state.profileFormats['image/avif'].quality).toBe(70);
    expect(res.state.customTiers).toEqual([{ label: '0.5×', scale: 0.5, suffix: '_540p' }]);
    expect(res.state.effort).toBe(3);
    expect(res.state.scaleAwareQ).toBe(true);
  });

  it('pngRecompress:false ⇒ level 0 (off)', () => {
    const res = parseBuildConfig(v1File(false));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.pngRecompressLevel).toBe(0);
      expect(res.state.pngRecompress).toBe(false);
    }
  });

  // The caller (SettingsPage ConfigCard) reads res.version to WARN (never silently) that an OLDER file was
  // applied as a full snapshot — its v2-only sections were backfilled to defaults. Pin the surfaced version.
  it('surfaces the parsed version (v1 file ⇒ 1) so the caller can warn on an older-config load', () => {
    const res = parseBuildConfig(v1File(true));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.version).toBe(1);
  });

  it('surfaces version === BUILD_CONFIG_VERSION for a current-version round-tripped file (no warning path)', () => {
    const res = parseBuildConfig(serializeBuildConfig(settingsDefaults()));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.version).toBe(BUILD_CONFIG_VERSION);
  });

  it('every v2-only section absent in a v1 file backfills from settingsDefaults() (B6: same live state)', () => {
    const res = parseBuildConfig(v1File(true));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d = settingsDefaults();
    expect(res.state.defaultTarget).toBe(d.defaultTarget);
    expect(res.state.defaultQuality).toBe(d.defaultQuality);
    expect(res.state.webpNearLossless).toBe(d.webpNearLossless);
    expect(res.state.padding).toBe(d.padding);
    expect(res.state.maxSize).toBe(d.maxSize);
    expect(res.state.maxEdge).toBe(d.maxEdge);
    expect(res.state.packMode).toBe(d.packMode);
    expect(res.state.spinePageFormat).toBe(d.spinePageFormat);
    expect(res.state.tierEnable).toBe(d.tierEnable);
    expect(res.state.tierSuffixes).toEqual(d.tierSuffixes);
    expect(res.state.frameRedundancy).toBe(d.frameRedundancy);
    expect(res.state.trimMargin).toBe(d.trimMargin);
    expect(res.state.includeFileSizes).toBe(d.includeFileSizes);
  });

  it('a numeric pngRecompressLevel WINS over the legacy boolean when both are present', () => {
    const obj = JSON.parse(v1File(true));
    obj.globals.pngRecompressLevel = 5;
    const res = parseBuildConfig(JSON.stringify(obj));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.state.pngRecompressLevel).toBe(5);
  });

  it('migrated true ⇒ the profile carries pngRecompressLevel 2 — the SAME wire value the old boolean sent', () => {
    const res = parseBuildConfig(v1File(true));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const profile = buildProfileFromState(res.state);
    expect(profile?.pngRecompressLevel).toBe(2);
  });
});

describe('never serialized / never restored — backend ops + consent (per-run invariant)', () => {
  it('the serialized file carries NO backend keys even when the live toggles are on', () => {
    const s = { ...richSettings(), ktx2Enable: true, pngquantEnable: true, resampleEnable: true };
    const text = serializeBuildConfig(s);
    for (const needle of ['ktx2', 'pngquant', 'resample', 'consent', 'backend', 'marking', 'excludeKinds']) {
      expect(text).not.toContain(needle);
    }
  });

  it('injected backend/consent keys in a file are NEVER restored — parse always returns the defaults', () => {
    const obj = JSON.parse(serializeBuildConfig(richSettings()));
    obj.backend = { ktx2Enable: true, consent: true };
    obj.output.ktx2Enable = true;
    obj.ktx2Enable = true;
    obj.pngquantEnable = true;
    obj.resampleEnable = true;
    const res = parseBuildConfig(JSON.stringify(obj));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.ktx2Enable).toBe(false);
      expect(res.state.pngquantEnable).toBe(false);
      expect(res.state.resampleEnable).toBe(false);
    }
  });
});

describe('fail-closed parse — never throws, returns a reasonKey', () => {
  it('malformed JSON → fix.config.err.malformed (does NOT throw)', () => {
    let res!: ReturnType<typeof parseBuildConfig>;
    expect(() => (res = parseBuildConfig('{ not json'))).not.toThrow();
    expect(res).toEqual({ ok: false, reasonKey: 'fix.config.err.malformed' });
  });

  it('not an object: a bare number / null / array → fix.config.err.notObject', () => {
    expect(parseBuildConfig('42')).toEqual({ ok: false, reasonKey: 'fix.config.err.notObject' });
    expect(parseBuildConfig('null')).toEqual({ ok: false, reasonKey: 'fix.config.err.notObject' });
    expect(parseBuildConfig('[]')).toEqual({ ok: false, reasonKey: 'fix.config.err.notObject' });
  });

  it('wrong/missing kind → fix.config.err.wrongKind', () => {
    expect(parseBuildConfig(JSON.stringify({ version: 2, profile: {}, globals: {} }))).toEqual({
      ok: false,
      reasonKey: 'fix.config.err.wrongKind',
    });
    expect(parseBuildConfig(JSON.stringify({ kind: 'something-else', version: 2 }))).toEqual({
      ok: false,
      reasonKey: 'fix.config.err.wrongKind',
    });
  });

  it('FUTURE version (3 / 99) → fix.config.err.version with detail (never silently mis-parsed)', () => {
    for (const v of [3, 99]) {
      const res = parseBuildConfig(JSON.stringify({ kind: 'asset-doctor/build-config', version: v }));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reasonKey).toBe('fix.config.err.version');
        expect(res.detail).toBe(String(v));
      }
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
    const s = richSettings();
    const obj = JSON.parse(serializeBuildConfig(s));
    obj.attack = 'rm -rf';
    obj.profile.bogus = { evil: true };
    obj.globals.unknown = 7;
    obj.packing.watcher = true;
    const res = parseBuildConfig(JSON.stringify(obj));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.state).toEqual({ ...s, pngRecompress: true }); // extras dropped, no leakage
  });

  it('partial config (no globals, missing a format entry, no v2 sections) → backfilled from defaults, ok', () => {
    const partial = {
      kind: 'asset-doctor/build-config',
      version: 2,
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
      expect(res.state.pngRecompressLevel).toBe(0);
      expect(res.state.profileAvifSubsample).toBeUndefined();
      expect(res.state.padding).toBe(2); // v2 sections at defaults
      expect(res.state.defaultTarget).toBe('image/avif');
    }
  });

  it('wrong-typed fields (effort:"x", customTiers:{}, formats array) → no throw, coerced, deterministic', () => {
    const garbage = {
      kind: 'asset-doctor/build-config',
      version: 2,
      profile: { enabled: true, formats: { 'image/avif': { enabled: 'yes', quality: 'high', lossless: 1, near: null } }, customTiers: {}, overrides: 'nope' },
      globals: { effort: 'x', scaleAwareQuality: 3, pngRecompress: 'maybe', webpNearLossless: 'later' },
      defaults: 'not-an-object',
      packing: [],
      rules: null,
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
      expect(res.state.pngRecompressLevel).toBe(0); // 'maybe' is not true → 0
      expect(res.state.webpNearLossless).toBe(false); // 'later' → default
      expect(res.state.defaultTarget).toBe('image/avif'); // non-object section → all defaults
      expect(res.state.padding).toBe(2); // array section → treated as absent
      expect(res.state.aggressive).toBe(false); // null section → treated as absent
    }
    // deterministic: re-coercing the same garbage yields the same settings
    expect(pickSettings(garbage)).toEqual(pickSettings(JSON.parse(JSON.stringify(garbage))));
  });

  it('v2 enum/number coercion matrix (each falls back / clamps, never rejects the file)', () => {
    const obj = JSON.parse(serializeBuildConfig(settingsDefaults()));
    obj.defaults = { target: 'image/gif', quality: 200 };
    obj.globals.effort = 99;
    obj.globals.pngRecompressLevel = 9;
    obj.rules.overrides = [{ match: 'ui/', quality: 3 }, { match: 'fx/', quality: 'x' }, { quality: 0.5 }, 7];
    obj.packing = { padding: 99, maxSize: 64, extrude: 7, packLoose: 'yes', packMode: 'weird', packGranularity: 'nope', packTrim: 0, polygon: 1, spinePageFormat: 'PROFILE' };
    obj.resize = { maxEdge: 1e9, tierEnable: true, tierSuffixes: ['_540p', '_bogus', 7] };
    obj.output = { hashFilenames: 'y', emitPixiManifest: null, includeFileSizes: 'zip' };
    const res = parseBuildConfig(JSON.stringify(obj));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state.defaultTarget).toBe('image/avif'); // unknown mime → default
    expect(res.state.defaultQuality).toBe(100); // clamped
    expect(res.state.effort).toBe(6); // clamped into the validator range
    expect(res.state.pngRecompressLevel).toBe(6); // clamped
    expect(res.state.overrides).toEqual([
      { match: 'ui/', quality: 1 }, // clamped into [0,1]
      { match: 'fx/', quality: 0.85 }, // non-number → legacy default
    ]); // match-less / non-object rows dropped
    expect(res.state.padding).toBe(32); // clamped
    expect(res.state.maxSize).toBe(128); // clamped up
    expect(res.state.extrude).toBe(0); // outside {0,1,2} → 0
    expect(res.state.packLoose).toBe(false); // non-boolean → default
    expect(res.state.packMode).toBe('auto');
    expect(res.state.packGranularity).toBe('per-leaf-folder');
    expect(res.state.packTrim).toBe(true);
    expect(res.state.polygon).toBe(false);
    expect(res.state.spinePageFormat).toBe('png'); // case-sensitive enum → default
    expect(res.state.maxEdge).toBe(16384); // clamped
    expect(res.state.tierEnable).toBe(true);
    expect(res.state.tierSuffixes).toEqual(['_540p']); // unknown suffixes dropped, ladder intersect
    expect(res.state.hashFilenames).toBe(false);
    expect(res.state.emitPixiManifest).toBe(false);
    expect(res.state.includeFileSizes).toBe('off');
  });

  it('an explicit EMPTY tierSuffixes array is preserved (distinct from absent ⇒ default ladder)', () => {
    const obj = JSON.parse(serializeBuildConfig(settingsDefaults()));
    obj.resize.tierSuffixes = [];
    const res = parseBuildConfig(JSON.stringify(obj));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.state.tierSuffixes).toEqual([]);
    delete obj.resize.tierSuffixes;
    const res2 = parseBuildConfig(JSON.stringify(obj));
    expect(res2.ok).toBe(true);
    if (res2.ok) expect(res2.state.tierSuffixes).toEqual(['_720p', '_540p']);
  });
});

describe('fail-closed semantics — validateProfile is the gate', () => {
  it('lossless AVIF is forced LOSSY by buildProfileFromState — the file path can NEVER produce a faked-lossless AVIF', () => {
    // HONESTY: the UI/config shape carries a per-format `lossless` boolean even for AVIF, but
    // buildProfileFromState ALWAYS emits AVIF as lossy (the UI has no honest lossless-AVIF path). So a
    // hand-edited file with image/avif.lossless:true can't smuggle a losslessAvif target past the validator —
    // it's structurally impossible, the strongest form of fail-closed. Assert the rebuilt profile is lossy.
    const smuggled = {
      kind: 'asset-doctor/build-config',
      version: 2,
      profile: {
        enabled: true,
        formats: { 'image/avif': { enabled: true, quality: 70, lossless: true, near: false } },
        customTiers: [],
      },
      globals: { effort: 0, scaleAwareQuality: false, pngRecompressLevel: 0, webpNearLossless: false },
    };
    const res = parseBuildConfig(JSON.stringify(smuggled));
    expect(res.ok).toBe(true); // accepted — because it's a LOSSY AVIF, never a lossless one
    if (res.ok) {
      const profile = buildProfileFromState(res.state);
      expect(profile?.formats).toEqual([{ format: 'image/avif', quality: 70 }]); // no `lossless` key
    }
    // And a genuinely-invalid GLOBAL avif knob (subsample 9) IS rejected by validateProfile (the gate).
    const badSub = { ...richSettings(), profileAvifSubsample: 9 };
    const bad = parseBuildConfig(serializeBuildConfig(badSub));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reasonKey).toBe('fix.config.err.invalid');
      expect(bad.detail).toContain('badSubsample');
    }
  });

  it('duplicate tier suffix (two custom tiers, same suffix) → fix.config.err.invalid (tier dupSuffix)', () => {
    const dupTier = {
      ...richSettings(),
      customTiers: [
        { label: 'a', scale: 0.5, suffix: '_540p' },
        { label: 'b', scale: 0.6, suffix: '_540p' },
      ],
    };
    const res = parseBuildConfig(serializeBuildConfig(dupTier));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reasonKey).toBe('fix.config.err.invalid');
      expect(res.detail).toContain('dupSuffix');
    }
  });

  it('bad tier suffix (a dot would fake an extension) → fix.config.err.invalid (tier badSuffix)', () => {
    const badSuffix = { ...richSettings(), customTiers: [{ label: 'x', scale: 0.5, suffix: '_bad.suffix' }] };
    const res = parseBuildConfig(serializeBuildConfig(badSuffix));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reasonKey).toBe('fix.config.err.invalid');
      expect(res.detail).toContain('badSuffix');
    }
  });

  it('empty formats (enabled profile, no format selected) → fix.config.err.invalid (emptyFormats)', () => {
    const d = settingsDefaults();
    const empty = {
      ...d,
      profileEnable: true,
      profileFormats: {
        ...d.profileFormats,
        'image/avif': { ...d.profileFormats['image/avif'], enabled: false },
      },
    };
    const res = parseBuildConfig(serializeBuildConfig(empty));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reasonKey).toBe('fix.config.err.invalid');
      expect(res.detail).toContain('emptyFormats');
    }
  });

  it('a saved-but-DISABLED config with valid formats still loads ok (apply the disabled flag as-is)', () => {
    const s = { ...richSettings(), profileEnable: false };
    const res = parseBuildConfig(serializeBuildConfig(s));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.state.profileEnable).toBe(false);
  });
});

describe('no-drift guard — buildProfileFromState pins the single UI→ExportProfile mapping', () => {
  it('builds the EXACT ExportProfile the App memo would (near→60, effort folded only >0, avifSubsample present)', () => {
    const profile = buildProfileFromState(richSettings());
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

  it('effort OMITTED when 0; avifSubsample OMITTED when undefined; scaleAware/pngRecompressLevel omitted at defaults', () => {
    const minimal = { ...settingsDefaults(), profileEnable: true };
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
    expect(buildProfileFromState({ ...richSettings(), profileEnable: false })).toBeUndefined();
    const noFmt = richSettings();
    noFmt.profileFormats = {
      'image/png': { enabled: false, quality: 85, lossless: true, near: false, pngLossy: false },
      'image/webp': { enabled: false, quality: 85, lossless: false, near: false },
      'image/avif': { enabled: false, quality: 85, lossless: false, near: false },
    };
    expect(buildProfileFromState(noFmt)).toBeUndefined();
  });

  it('TRANSITIONAL: still accepts the legacy 8-field slice (pngRecompress boolean ⇒ level 2 fold)', () => {
    const legacy: BuildConfigState = {
      profileEnable: true,
      profileFormats: settingsDefaults().profileFormats,
      customTiers: [],
      profileOverrides: [],
      profileAvifSubsample: undefined,
      effort: 0,
      scaleAwareQ: false,
      pngRecompress: true,
    };
    expect(buildProfileFromState(legacy)?.pngRecompressLevel).toBe(2);
    expect(buildProfileFromState({ ...legacy, pngRecompress: false })?.pngRecompressLevel).toBeUndefined();
  });
});

describe('TRANSITIONAL legacy serialize (pre-migration App.tsx save path)', () => {
  it('a legacy BuildConfigState save upgrades to a v2 file: profile+globals applied, the rest = defaults', () => {
    const legacy: BuildConfigState = {
      profileEnable: true,
      profileFormats: richSettings().profileFormats,
      customTiers: [{ label: '0.5×', scale: 0.5, suffix: '_540p' }],
      profileOverrides: [],
      profileAvifSubsample: 3,
      effort: 4,
      scaleAwareQ: true,
      pngRecompress: true,
    };
    const obj = JSON.parse(serializeBuildConfig(legacy));
    expect(obj.version).toBe(2);
    expect(obj.globals).toEqual({ effort: 4, scaleAwareQuality: true, pngRecompressLevel: 2, webpNearLossless: false });
    expect(obj.defaults).toEqual({ target: 'image/avif', quality: 85 }); // today's hardcodes ARE the defaults
    expect(obj.packing.padding).toBe(2);
    const res = parseBuildConfig(JSON.stringify(obj));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.pngRecompressLevel).toBe(2);
      expect(res.state.profileAvifSubsample).toBe(3);
    }
  });
});

it('BUILD_CONFIG_VERSION is 2; v1 files are accepted (migration), v3 is rejected (fail-closed)', () => {
  expect(BUILD_CONFIG_VERSION).toBe(2);
  expect(parseBuildConfig(v1File(false)).ok).toBe(true);
  expect(parseBuildConfig(JSON.stringify({ kind: 'asset-doctor/build-config', version: 3 })).ok).toBe(false);
});
