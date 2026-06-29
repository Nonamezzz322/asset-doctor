// Shared UI types for the export-profile panel (round7-export-profile.md §7) — extracted here so the pure
// build-config module (build-config.ts) can reference them WITHOUT importing App.tsx (which imports
// build-config.ts back — a circular import). App.tsx re-exports these verbatim, so existing imports and
// behavior are unchanged; this file is type/const-only (no React, no IO). See ab-r5-design §10 edge case 10.

import type { ExportFormat } from '@asset-doctor/core';

/** Per-format UI settings (the format checkbox state lives in `enabled`). Honest browser subset only. */
export interface ProfileFormatState {
  enabled: boolean;
  /** 0..100 lossy quality (ignored when lossless or for png). */
  quality: number;
  /** webp/png lossless (AVIF disabled in the UI — no honest path). */
  lossless: boolean;
  /** webp near-lossless toggle (maps to near=60 when on; off ⇒ omit ⇒ near off). */
  near: boolean;
  /** PNG ONLY (round13): route this PNG target through the OPT-IN pngquant backend (lossy-indexed
   *  re-compression → smaller download). Maps to FormatTarget.pngLossy. Has effect ONLY when the pngquant
   *  backend op is also enabled + consented; otherwise the worker emits a lossless PNG (honest fallback).
   *  DISK-ONLY — no VRAM change. Off ⇒ ordinary native-lossless PNG (byte-identical to today). */
  pngLossy?: boolean;
}

export const FORMAT_KEYS: { mime: ExportFormat; key: string }[] = [
  { mime: 'image/png', key: 'fix.profile.format.png' },
  { mime: 'image/webp', key: 'fix.profile.format.webp' },
  { mime: 'image/avif', key: 'fix.profile.format.avif' },
];

/** One UI override rule (round10-profile-overrides.md §6). `match` is a dir-aware prefix / exact ref /
 *  `type:loose|pixi|spine` key; `mode` chooses the headline preset (Fonts→AVIF 4:4:4) or a quality/lossless
 *  overlay. Mapped to a core ProfileOverride in the exportProfile memo; blank `match` rows are dropped so a
 *  half-typed row never silently matches. DISTINCT from the legacy SettingsPanel per-folder overrides
 *  (opts.overrides) — these ride INSIDE the export profile and govern its per-ref fan-out. */
export type OverrideMode = 'fonts444' | 'quality' | 'lossless';
export interface UiOverride {
  match: string;
  mode: OverrideMode;
  /** Lossy quality 0..100 for the 'quality' (and 'fonts444' AVIF) modes; ignored for 'lossless'. */
  quality?: number;
}

export const OVERRIDE_MODE_KEYS: { mode: OverrideMode; key: string }[] = [
  { mode: 'quality', key: 'fix.profile.overrideMode.quality' },
  { mode: 'lossless', key: 'fix.profile.overrideMode.lossless' },
  { mode: 'fonts444', key: 'fix.profile.overrideMode.fonts444' },
];
